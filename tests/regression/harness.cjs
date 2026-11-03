/**
 * Test harness: swaps `@prisma/client` for the schema-aware in-memory database (memdb.cjs), registers tsx so the
 * real TypeScript services/routes can be required, and exposes helpers (seed, signed session tokens, route calls).
 * Skips (returns null) when @prisma/prisma-schema-wasm is not installed.
 */
const path = require('path');
const loadDmmf = require('./dmmf.cjs');

const ROOT = path.resolve(__dirname, '../..');
process.chdir(ROOT);
process.env.TSX_TSCONFIG_PATH = path.join(ROOT, 'tsconfig.json');
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-test-secret-test-secret-123456';
process.env.SEED_PASSWORD = 'Test-Password-1';
process.env.NODE_ENV = 'test';

const dm = loadDmmf();
let H = null;

if (dm) {
  require(path.join(ROOT, 'node_modules/tsx/dist/cjs/index.cjs'));
  const { Decimal } = require(path.join(ROOT, 'node_modules/@prisma/client/runtime/library'));
  const db = require('./memdb.cjs')(dm, Decimal);

  let current = db.client; // what `new PrismaClient()` hands out right now
  const fake = {
    PrismaClient: class { constructor() { return current; } },
    Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' }, PrismaClientKnownRequestError: db.KnownErr },
  };
  const clientPath = require.resolve('@prisma/client', { paths: [ROOT] });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fake };
  delete globalThis.prisma;

  const load = (rel) => require(path.join(ROOT, rel));

  async function seed() {
    const seedPath = path.join(ROOT, 'prisma/seed.ts');
    delete require.cache[seedPath];
    let finish;
    const done = new Promise((r) => { finish = r; });
    current = new Proxy(db.client, { get: (t, p) => (p === '$disconnect' ? async () => finish() : t[p]) });
    const origLog = console.log;
    console.log = () => {};
    try { require(seedPath); await done; } finally { console.log = origLog; current = db.client; }
  }

  async function tokenFor(userId, role) {
    const { signSession } = load('src/lib/session.ts');
    return signSession({ uid: userId, role, exp: Math.floor(Date.now() / 1000) + 600 });
  }

  /** Call a route module's handler the way Next would. */
  async function call(routeRel, method, { params = {}, body, token } = {}) {
    const mod = load(routeRel);
    const headers = { 'content-type': 'application/json' };
    if (token) headers.cookie = `exim_session=${encodeURIComponent(token)}`;
    const req = new Request('http://localhost/test', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await mod[method](req, { params: Promise.resolve(params) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }

  H = { db, Decimal, load, seed, tokenFor, call, ROOT };
}

module.exports = H;
