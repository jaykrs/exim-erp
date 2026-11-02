// Runs prisma/seed.ts against a fake client that validates every write against the schema (DMMF):
// unknown models/fields, bad enum values, missing required columns, wrong unique selectors, dangling FK ids,
// and idempotency (second run creates nothing new). Checks shape, NOT SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const loadDmmf = require('./dmmf.cjs');

const ROOT = path.resolve(__dirname, '../..');
const dm = loadDmmf();
const skip = dm ? false : 'install @prisma/prisma-schema-wasm to run seed regression';

const norm = (v) => (v instanceof Date ? v.getTime() : v);

function buildFake() {
  const models = Object.fromEntries(dm.models.map((m) => [m.name[0].toLowerCase() + m.name.slice(1), m]));
  const enums = Object.fromEntries(dm.enums.map((e) => [e.name, new Set(e.values.map((v) => v.name))]));
  const store = {}; // model -> rows
  const errors = [];
  const seq = {};

  const uniqueSelectors = (m) => {
    const sel = new Map();
    for (const f of m.fields) if (f.isId || f.isUnique) sel.set(f.name, [f.name]);
    for (const u of [...(m.uniqueIndexes ?? []), ...(dm.indexes ?? []).filter((i) => i.model === m.name && i.type === 'unique').map((i) => ({ name: i.name, fields: i.fields.map((x) => x.name) }))]) {
      sel.set(u.name ?? u.fields.join('_'), u.fields);
    }
    if (m.primaryKey) sel.set(m.primaryKey.name ?? m.primaryKey.fields.join('_'), m.primaryKey.fields);
    return sel;
  };

  function checkData(mName, m, data, { requireAll }) {
    const byName = Object.fromEntries(m.fields.map((f) => [f.name, f]));
    for (const [k, v] of Object.entries(data)) {
      const f = byName[k];
      if (!f) { errors.push(`${mName}: unknown field "${k}"`); continue; }
      if (f.kind === 'object') { errors.push(`${mName}: nested relation write "${k}" not expected in seed`); continue; }
      if (f.kind === 'enum' && v != null && !enums[f.type].has(v)) errors.push(`${mName}.${k}: "${v}" is not in enum ${f.type}`);
      if (v == null && f.isRequired && !f.hasDefaultValue) errors.push(`${mName}.${k}: null for required column`);
      if (f.type === 'Decimal' && v != null && !/^-?\d+(\.\d+)?$/.test(String(v))) errors.push(`${mName}.${k}: bad decimal "${v}"`);
      if (f.isRelationFromFk) {}
    }
    if (requireAll) {
      for (const f of m.fields) {
        if (f.kind === 'object' || f.isList) continue;
        if (f.isRequired && !f.hasDefaultValue && !f.isUpdatedAt && !(f.name in data)) errors.push(`${mName}: required column "${f.name}" missing on create`);
      }
      // FK integrity: any *Id column pointing at a relation must reference an existing row
      for (const rel of m.fields.filter((f) => f.kind === 'object' && f.relationFromFields?.length)) {
        const fk = rel.relationFromFields[0];
        if (data[fk] != null) {
          const target = rel.type[0].toLowerCase() + rel.type.slice(1);
          const refField = rel.relationToFields[0];
          const hit = (store[target] ?? []).some((r) => r[refField] === data[fk]);
          if (!hit) errors.push(`${mName}.${fk}=${data[fk]} dangles (no ${rel.type}.${refField} row yet)`);
        }
      }
    }
  }

  function matchWhere(mName, m, where) {
    const sel = uniqueSelectors(m);
    const keys = Object.keys(where);
    if (keys.length === 1 && sel.has(keys[0])) {
      const cols = sel.get(keys[0]);
      const val = cols.length === 1 && !(typeof where[keys[0]] === 'object' && where[keys[0]] !== null) ? { [cols[0]]: where[keys[0]] } : where[keys[0]];
      for (const c of cols) if (!(c in val)) errors.push(`${mName}: unique selector ${keys[0]} missing ${c}`);
      return (r) => cols.every((c) => norm(r[c]) === norm(val[c]));
    }
    return null;
  }

  const rows = (name) => (store[name] ??= []);
  const insert = (name, m, data) => {
    seq[name] = (seq[name] ?? 0) + 1;
    const row = { ...data };
    const idField = m.fields.find((f) => f.isId);
    if (idField && row[idField.name] == null) row[idField.name] = seq[name];
    rows(name).push(row);
    return row;
  };

  const modelProxy = (name) => {
    const m = models[name];
    if (!m) { errors.push(`unknown model "${name}"`); return {}; }
    return {
      upsert: async ({ where, update, create }) => {
        const pred = matchWhere(name, m, where);
        if (!pred) { errors.push(`${name}.upsert: where {${Object.keys(where)}} is not a unique selector`); return {}; }
        const hit = rows(name).find(pred);
        if (hit) return hit;
        checkData(name, m, create, { requireAll: true });
        return insert(name, m, create);
      },
      create: async ({ data }) => { checkData(name, m, data, { requireAll: true }); return insert(name, m, data); },
      findFirst: async ({ where }) => rows(name).find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    };
  };
  const hooks = { onDisconnect: () => {} };
  const client = new Proxy({}, {
    get: (_, prop) => (prop === '$disconnect' ? async () => hooks.onDisconnect() : modelProxy(String(prop))),
  });
  return { client, store, errors, hooks };
}

async function runSeed(fake) {
  const { client, hooks } = fake;
  const clientPath = require.resolve('@prisma/client', { paths: [ROOT] });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { PrismaClient: class { constructor() { return client; } } } };
  const seedPath = path.join(ROOT, 'prisma/seed.ts');
  delete require.cache[seedPath];
  const done = new Promise((resolve) => { hooks.onDisconnect = resolve; });
  require(seedPath);
  await done;
}

test('seed.ts writes only valid rows, resolves every FK, and is idempotent', { skip }, async () => {
  process.chdir(ROOT);
  require(path.join(ROOT, 'node_modules/tsx/dist/cjs/index.cjs'));
  const logs = [];
  const origLog = console.log; console.log = (...a) => logs.push(a.join(' '));
  const sizes = (st) => JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.length])));
  try {
    const fake = buildFake();
    await runSeed(fake);
    assert.deepEqual(fake.errors, []);
    const counts = Object.fromEntries(Object.entries(fake.store).map(([k, v]) => [k, v.length]));
    assert.equal(counts.company, 1);
    assert.equal(counts.shipment, 2);
    assert.equal(counts.shipmentItem, 2);
    assert.equal(counts.container, 2);
    assert.ok(counts.hsRegulatoryRule >= 4 && counts.hsDutyRate >= 4 && counts.exchangeRate >= 4);
    // idempotency: running again against the SAME store must insert nothing
    const before = sizes(fake.store);
    await runSeed(fake);
    assert.deepEqual(fake.errors, []);
    assert.equal(sizes(fake.store), before, 'second run must not insert additional rows');
    assert.ok(logs.some((l) => l.startsWith('Seeded.')));
  } finally { console.log = origLog; }
});
