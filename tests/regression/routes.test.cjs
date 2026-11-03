// Route-level checks: authentication, role checks, validation, path-id precedence, login and session integrity.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.cjs');
const skip = H ? false : 'install @prisma/prisma-schema-wasm to run route tests';

async function users() {
  H.db.reset();
  await H.seed();
  const list = await H.db.client.user.findMany({});
  const by = Object.fromEntries(list.map((u) => [u.role, u]));
  return by;
}
const LEO = 'src/app/api/shipments/[id]/leo/route.ts';

test('no session → 401; viewer → 403; tampered/expired tokens rejected', { skip }, async () => {
  const u = await users();
  const body = { leoNo: 'L1', leoDate: '2026-10-30' };
  assert.equal((await H.call(LEO, 'POST', { params: { id: '1' }, body })).status, 401);
  const viewer = await H.tokenFor(u.VIEWER.id, 'VIEWER');
  const r = await H.call(LEO, 'POST', { params: { id: '1' }, body, token: viewer });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'FORBIDDEN');

  const good = await H.tokenFor(u.LOGISTICS_MANAGER.id, 'LOGISTICS_MANAGER');
  const [p, sig] = good.split('.');
  const forged = `${Buffer.from(JSON.stringify({ uid: u.ADMIN.id, role: 'ADMIN', exp: 9999999999 })).toString('base64url')}.${sig}`;
  assert.equal((await H.call(LEO, 'POST', { params: { id: '1' }, body, token: forged })).status, 401);
  const { signSession } = H.load('src/lib/session.ts');
  const expired = await signSession({ uid: u.ADMIN.id, role: 'ADMIN', exp: Math.floor(Date.now() / 1000) - 5 });
  assert.equal((await H.call(LEO, 'POST', { params: { id: '1' }, body, token: expired })).status, 401);
});

test('allowed role passes auth; invalid body → 422; path id overrides body id', { skip }, async () => {
  const u = await users();
  const tok = await H.tokenFor(u.LOGISTICS_MANAGER.id, 'LOGISTICS_MANAGER');
  const bad = await H.call(LEO, 'POST', { params: { id: '1' }, body: { leoNo: '' }, token: tok });
  assert.equal(bad.status, 422);
  const unknownKey = await H.call(LEO, 'POST', { params: { id: '1' }, body: { leoNo: 'L', leoDate: '2026-10-30', extra: 1 }, token: tok });
  assert.equal(unknownKey.status, 422, 'strict schemas reject unknown keys');
  const missing = await H.call(LEO, 'POST', { params: { id: '999999' }, body: { id: 1, leoNo: 'L', leoDate: '2026-10-30' }, token: tok });
  assert.equal(missing.status, 404, 'URL id (999999) wins over body id (1)');
});

test('read endpoints need a session but no write permission', { skip }, async () => {
  const u = await users();
  const T = 'src/app/api/shipments/[id]/timeline/route.ts';
  assert.equal((await H.call(T, 'GET', { params: { id: '1' } })).status, 401);
  const r = await H.call(T, 'GET', { params: { id: '1' }, token: await H.tokenFor(u.VIEWER.id, 'VIEWER') });
  assert.equal(r.status, 200);
  assert.ok(r.body.data?.stages ?? r.body.stages);
});

test('login: success sets cookie, wrong password and unknown user are indistinguishable', { skip }, async () => {
  await users();
  const L = 'src/app/api/auth/login/route.ts';
  const ok = await H.call(L, 'POST', { body: { email: 'admin@demo-exim.test', password: 'Test-Password-1' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', /exim_session=.*HttpOnly/i);
  const wrong = await H.call(L, 'POST', { body: { email: 'admin@demo-exim.test', password: 'nope' } });
  const none = await H.call(L, 'POST', { body: { email: 'ghost@demo-exim.test', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, none.body);
  assert.doesNotMatch(JSON.stringify(ok.body), /passwordHash|scrypt/);
});

test('password hashing round-trips and rejects wrong input', { skip }, async () => {
  const { hashPassword, verifyPassword } = H.load('src/lib/password.ts');
  const h = await hashPassword('abc12345');
  assert.equal(await verifyPassword('abc12345', h), true);
  assert.equal(await verifyPassword('abc12346', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('RBAC matrix: only listed roles hold each write permission', { skip }, async () => {
  const { can, PERMISSIONS, ROLES } = H.load('src/lib/rbac.ts');
  for (const role of ROLES) assert.equal(can(role, 'read'), true);
  assert.equal(can('VIEWER', 'finance:write'), false);
  assert.equal(can('FINANCE_CONTROLLER', 'warehouse:write'), false);
  assert.equal(can('ADMIN', 'customs:write'), true);
  assert.ok(Object.keys(PERMISSIONS).length >= 8);
});
