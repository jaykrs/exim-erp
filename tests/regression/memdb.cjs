/**
 * Schema-aware in-memory stand-in for PrismaClient, driven by the DMMF of prisma/schema.prisma.
 *
 * It lets the REAL services run end to end without MySQL or a generated client, and it checks every write
 * against the schema: unknown fields, enum values, required columns, VARCHAR length, DECIMAL scale,
 * unique constraints (P2002), foreign keys (P2003), update-of-missing-row (P2025). Non-fatal schema
 * problems are collected in `db.problems` so a test can assert it is empty.
 *
 * Interactive $transaction rolls the whole store back if the callback throws — so all-or-nothing is testable.
 * NOT a SQL engine: no locking, no isolation levels, simple where/orderBy only.
 */
const path = require('path');

module.exports = function createMemDb(dm, Decimal) {
  const models = Object.fromEntries(dm.models.map((m) => [m.name[0].toLowerCase() + m.name.slice(1), m]));
  const byName = Object.fromEntries(dm.models.map((m) => [m.name, m]));
  const enums = Object.fromEntries(dm.enums.map((e) => [e.name, new Set(e.values.map((v) => v.name))]));
  const problems = [];
  let store = {};
  let seq = {};

  class KnownErr extends Error {
    constructor(message, code, meta) { super(message); this.name = 'PrismaClientKnownRequestError'; this.code = code; this.meta = meta; }
  }

  const rows = (m) => (store[m.name] ??= []);
  const isDec = (v) => v instanceof Decimal;
  const norm = (v) => (v instanceof Date ? v.getTime() : isDec(v) ? v.toString() : typeof v === 'bigint' ? Number(v) : v);
  const eq = (a, b) => (isDec(a) || isDec(b) ? new Decimal(a).eq(new Decimal(b)) : norm(a) === norm(b));
  const cmp = (a, b) => {
    if (isDec(a) || isDec(b)) return new Decimal(a).cmp(new Decimal(b));
    const x = norm(a), y = norm(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const cloneVal = (v) => (v instanceof Date ? new Date(v.getTime()) : isDec(v) ? new Decimal(v) : Array.isArray(v) ? v.map(cloneVal) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  const cloneStore = (s) => Object.fromEntries(Object.entries(s).map(([k, list]) => [k, list.map((r) => Object.fromEntries(Object.entries(r).map(([c, v]) => [c, cloneVal(v)])))]));

  const fieldOf = (m, name) => m.fields.find((f) => f.name === name);
  const uniqueSelectors = (m) => {
    const sel = new Map();
    for (const f of m.fields) if (f.isId || f.isUnique) sel.set(f.name, [f.name]);
    for (const u of m.uniqueIndexes ?? []) sel.set(u.name ?? u.fields.join('_'), u.fields);
    if (m.primaryKey) sel.set(m.primaryKey.name ?? m.primaryKey.fields.join('_'), m.primaryKey.fields);
    return sel;
  };

  // ── value coercion + column checks ────────────────────────────────────────
  function coerce(m, f, v) {
    if (v === null || v === undefined) return v ?? null;
    const where = `${m.name}.${f.name}`;
    switch (f.type) {
      case 'Decimal': {
        let d;
        try { d = new Decimal(v); } catch { problems.push(`${where}: "${v}" is not a decimal`); return null; }
        const scale = Number(f.nativeType?.[1]?.[1] ?? NaN);
        if (!Number.isNaN(scale) && d.decimalPlaces() > scale) problems.push(`${where}: ${d} has more than ${scale} decimal places (MySQL would round)`);
        const prec = Number(f.nativeType?.[1]?.[0] ?? NaN);
        if (!Number.isNaN(prec) && d.abs().gte(new Decimal(10).pow(prec - (Number.isNaN(scale) ? 0 : scale)))) problems.push(`${where}: ${d} overflows DECIMAL(${prec},${scale})`);
        return d;
      }
      case 'DateTime': {
        const d = v instanceof Date ? v : new Date(v);
        if (Number.isNaN(d.getTime())) problems.push(`${where}: invalid date`);
        return d;
      }
      case 'Int': if (!Number.isInteger(v)) problems.push(`${where}: "${v}" is not an integer`); return v;
      case 'BigInt': return Number(v);
      case 'Boolean': if (typeof v !== 'boolean') problems.push(`${where}: "${v}" is not a boolean`); return v;
      case 'String': {
        if (typeof v !== 'string') { problems.push(`${where}: "${v}" is not a string`); return v; }
        const len = Number(f.nativeType?.[0] === 'VarChar' || f.nativeType?.[0] === 'Char' ? f.nativeType[1][0] : NaN);
        if (!Number.isNaN(len) && v.length > len) problems.push(`${where}: length ${v.length} exceeds VARCHAR(${len})`);
        return v;
      }
      case 'Json': return v;
      default:
        if (f.kind === 'enum') {
          if (!enums[f.type].has(v)) problems.push(`${where}: "${v}" is not in enum ${f.type}`);
        }
        return v;
    }
  }

  function applyDefaults(m, row) {
    for (const f of m.fields) {
      if (f.kind === 'object' || f.isList || row[f.name] !== undefined) continue;
      if (f.hasDefaultValue) {
        const d = f.default;
        if (d && typeof d === 'object' && !Array.isArray(d)) {
          if (d.name === 'autoincrement') { seq[m.name] = (seq[m.name] ?? 0) + 1; row[f.name] = seq[m.name]; }
          else if (d.name === 'now') row[f.name] = new Date();
          else row[f.name] = null; // uuid/cuid/dbgenerated: not used in this schema
        } else row[f.name] = f.type === 'Decimal' ? new Decimal(d) : d;
      } else if (f.isUpdatedAt) row[f.name] = new Date();
      else row[f.name] = null;
    }
  }

  function checkRow(m, row, selfRow, creating) {
    for (const f of m.fields) {
      if (f.kind === 'object' || f.isList) continue;
      if (creating && f.isRequired && row[f.name] == null) problems.push(`${m.name}.${f.name}: required column is null/missing on create`);
    }
    for (const [name, cols] of uniqueSelectors(m)) {
      if (cols.some((c) => row[c] == null)) continue;
      const clash = rows(m).find((r) => r !== selfRow && cols.every((c) => eq(r[c], row[c])));
      if (clash) throw new KnownErr(`Unique constraint failed on ${m.name}(${name})`, 'P2002', { target: cols });
    }
    for (const rel of m.fields.filter((f) => f.kind === 'object' && f.relationFromFields?.length)) {
      const fk = rel.relationFromFields;
      if (fk.some((c) => row[c] == null)) continue;
      const target = byName[rel.type];
      const ok = rows(target).some((t) => rel.relationToFields.every((c, i) => eq(t[c], row[fk[i]])));
      if (!ok) throw new KnownErr(`Foreign key constraint failed on ${m.name}.${fk.join(',')}`, 'P2003', { field: fk });
    }
  }

  // ── where / orderBy ───────────────────────────────────────────────────────
  function condition(m, f, row, cond) {
    const val = row[f.name];
    if (cond === null) return val == null;
    if (cond instanceof Date || isDec(cond) || typeof cond !== 'object') return val != null && eq(val, cond);
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case 'equals': return arg === null ? val == null : val != null && eq(val, arg);
        case 'in': return val != null && arg.some((a) => eq(val, a));
        case 'notIn': return val == null || !arg.some((a) => eq(val, a));
        case 'not': return arg === null ? val != null : typeof arg === 'object' && !(arg instanceof Date) && !isDec(arg) ? !condition(m, f, row, arg) : val == null || !eq(val, arg);
        case 'gt': return val != null && cmp(val, arg) > 0;
        case 'gte': return val != null && cmp(val, arg) >= 0;
        case 'lt': return val != null && cmp(val, arg) < 0;
        case 'lte': return val != null && cmp(val, arg) <= 0;
        case 'contains': return typeof val === 'string' && val.includes(arg);
        case 'startsWith': return typeof val === 'string' && val.startsWith(arg);
        case 'endsWith': return typeof val === 'string' && val.endsWith(arg);
        case 'mode': return true;
        default: problems.push(`${m.name}.${f.name}: unsupported filter operator "${op}"`); return false;
      }
    });
  }
  function matches(m, row, where) {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (k === 'AND') return [].concat(v).every((w) => matches(m, row, w));
      if (k === 'OR') return [].concat(v).some((w) => matches(m, row, w));
      if (k === 'NOT') return ![].concat(v).some((w) => matches(m, row, w));
      const f = fieldOf(m, k);
      if (!f) { problems.push(`${m.name}: unknown field "${k}" in where`); return false; }
      if (f.kind === 'object') { problems.push(`${m.name}: relation filter on "${k}" is not supported by memdb`); return false; }
      return condition(m, f, row, v);
    });
  }
  function expandUnique(m, where) {
    const sel = uniqueSelectors(m);
    const out = {};
    let found = false;
    for (const [k, v] of Object.entries(where ?? {})) {
      if (sel.has(k)) {
        found = true;
        const cols = sel.get(k);
        if (cols.length === 1 && !(v && typeof v === 'object' && !(v instanceof Date) && !isDec(v))) out[cols[0]] = v;
        else for (const c of cols) { if (!(c in v)) problems.push(`${m.name}: unique selector ${k} missing ${c}`); out[c] = v[c]; }
      } else out[k] = v;
    }
    if (!found) problems.push(`${m.name}: where {${Object.keys(where ?? {})}} is not a unique selector`);
    return out;
  }
  function order(list, m, orderBy) {
    if (!orderBy) return list;
    const keys = [].concat(orderBy).flatMap((o) => Object.entries(o));
    for (const [k] of keys) if (!fieldOf(m, k)) problems.push(`${m.name}: unknown field "${k}" in orderBy`);
    return [...list].sort((a, b) => {
      for (const [k, dir] of keys) {
        const c = a[k] == null ? (b[k] == null ? 0 : -1) : b[k] == null ? 1 : cmp(a[k], b[k]);
        if (c) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  // ── projection with nested select/include ─────────────────────────────────
  function related(m, f, row) {
    const target = byName[f.type];
    if (f.relationFromFields?.length) {
      return rows(target).find((t) => f.relationToFields.every((c, i) => eq(t[c], row[f.relationFromFields[i]]))) ?? null;
    }
    const inverse = target.fields.find((x) => x.relationName === f.relationName && x.relationFromFields?.length);
    if (!inverse) return f.isList ? [] : null;
    const list = rows(target).filter((t) => inverse.relationFromFields.every((c, i) => eq(t[c], row[inverse.relationToFields[i]])));
    return f.isList ? list : list[0] ?? null;
  }
  function project(m, row, args) {
    const base = {};
    const sel = args?.select, inc = args?.include;
    if (sel) {
      for (const [k, v] of Object.entries(sel)) {
        if (!v) continue;
        const f = fieldOf(m, k);
        if (!f) { problems.push(`${m.name}: unknown field "${k}" in select`); continue; }
        if (f.kind === 'object') base[k] = shapeRel(m, f, row, v === true ? undefined : v);
        else base[k] = row[k];
      }
      return base;
    }
    for (const f of m.fields) if (f.kind !== 'object') base[f.name] = row[f.name];
    if (inc) {
      for (const [k, v] of Object.entries(inc)) {
        if (!v) continue;
        const f = fieldOf(m, k);
        if (!f || f.kind !== 'object') { problems.push(`${m.name}: unknown relation "${k}" in include`); continue; }
        base[k] = shapeRel(m, f, row, v === true ? undefined : v);
      }
    }
    return base;
  }
  function shapeRel(m, f, row, args) {
    const target = byName[f.type];
    const r = related(m, f, row);
    if (f.isList) {
      let list = r.filter((x) => matches(target, x, args?.where));
      list = order(list, target, args?.orderBy);
      if (args?.skip) list = list.slice(args.skip);
      if (args?.take != null) list = list.slice(0, args.take);
      return list.map((x) => project(target, x, args));
    }
    return r ? project(target, r, args) : null;
  }

  // ── writes ────────────────────────────────────────────────────────────────
  function buildRow(m, data, creating, existing) {
    const row = existing ?? {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      const f = fieldOf(m, k);
      if (!f) { problems.push(`${m.name}: unknown field "${k}" in data`); continue; }
      if (f.kind === 'object') { problems.push(`${m.name}: nested write on relation "${k}" is not supported by memdb`); continue; }
      if (!creating && v && typeof v === 'object' && !(v instanceof Date) && !isDec(v) && f.type !== 'Json') {
        if ('increment' in v) { row[k] = coerce(m, f, f.type === 'Decimal' ? new Decimal(row[k]).plus(v.increment) : row[k] + v.increment); continue; }
        if ('decrement' in v) { row[k] = coerce(m, f, f.type === 'Decimal' ? new Decimal(row[k]).minus(v.decrement) : row[k] - v.decrement); continue; }
        if ('set' in v) { row[k] = coerce(m, f, v.set); continue; }
      }
      row[k] = coerce(m, f, v);
    }
    if (creating) applyDefaults(m, row);
    else for (const f of m.fields) if (f.isUpdatedAt) row[f.name] = new Date();
    return row;
  }
  function insert(m, data) {
    const row = buildRow(m, data, true);
    checkRow(m, row, null, true);
    rows(m).push(row);
    return row;
  }
  function mutate(m, row, data) {
    const before = { ...row };
    buildRow(m, data, false, row);
    try { checkRow(m, row, row, false); } catch (e) { Object.assign(row, before); throw e; }
  }

  function delegate(m) {
    const find = (where) => rows(m).filter((r) => matches(m, r, where));
    const one = (where) => rows(m).find((r) => matches(m, r, expandUnique(m, where)));
    return {
      findUnique: async (a) => { const r = one(a.where); return r ? project(m, r, a) : null; },
      findUniqueOrThrow: async (a) => { const r = one(a.where); if (!r) throw new KnownErr('Not found', 'P2025'); return project(m, r, a); },
      findFirst: async (a = {}) => {
        let list = order(find(a.where), m, a.orderBy);
        if (a.skip) list = list.slice(a.skip);
        return list[0] ? project(m, list[0], a) : null;
      },
      findMany: async (a = {}) => {
        let list = order(find(a.where), m, a.orderBy);
        if (a.skip) list = list.slice(a.skip);
        if (a.take != null) list = list.slice(0, a.take);
        return list.map((r) => project(m, r, a));
      },
      count: async (a = {}) => find(a.where).length,
      aggregate: async (a = {}) => {
        const list = find(a.where);
        const out = {};
        for (const op of ['_max', '_min']) {
          if (!a[op]) continue;
          out[op] = {};
          for (const k of Object.keys(a[op])) {
            const vals = list.map((r) => r[k]).filter((v) => v != null);
            out[op][k] = vals.length ? vals.reduce((x, y) => ((op === '_max' ? cmp(y, x) > 0 : cmp(y, x) < 0) ? y : x)) : null;
          }
        }
        return out;
      },
      create: async (a) => project(m, insert(m, a.data), a),
      createMany: async (a) => { for (const d of [].concat(a.data)) insert(m, d); return { count: [].concat(a.data).length }; },
      update: async (a) => {
        const r = one(a.where);
        if (!r) throw new KnownErr(`${m.name} to update not found`, 'P2025');
        mutate(m, r, a.data);
        return project(m, r, a);
      },
      updateMany: async (a) => { const list = find(a.where); for (const r of list) mutate(m, r, a.data); return { count: list.length }; },
      upsert: async (a) => {
        const r = one(a.where);
        if (r) { mutate(m, r, a.update); return project(m, r, a); }
        return project(m, insert(m, a.create), a);
      },
      delete: async (a) => {
        const r = one(a.where);
        if (!r) throw new KnownErr('Not found', 'P2025');
        store[m.name] = rows(m).filter((x) => x !== r);
        return project(m, r, a);
      },
      deleteMany: async (a = {}) => { const list = find(a.where); store[m.name] = rows(m).filter((x) => !list.includes(x)); return { count: list.length }; },
    };
  }

  const delegates = {};
  const client = new Proxy({}, {
    get(_, prop) {
      if (prop === '$transaction') {
        return async (fn) => {
          const snap = cloneStore(store), seqSnap = { ...seq };
          try { return await fn(client); } catch (e) { store = snap; seq = seqSnap; throw e; }
        };
      }
      if (prop === '$disconnect') return async () => {};
      if (prop === 'then') return undefined;
      const m = models[String(prop)];
      if (!m) { problems.push(`unknown model "${String(prop)}"`); return {}; }
      return (delegates[prop] ??= delegate(m));
    },
  });

  return {
    client,
    KnownErr,
    problems,
    reset() { store = {}; seq = {}; problems.length = 0; },
    table: (name) => rows(byName[name]).map((r) => ({ ...r })),
    count: (name) => rows(byName[name]).length,
    snapshot: () => cloneStore(store),
  };
};
