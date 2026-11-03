// Contract tests: hand-written TypeScript unions / string literals must stay in sync with schema.prisma.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const loadDmmf = require('./dmmf.cjs');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const dm = loadDmmf();
const skip = dm ? false : 'install @prisma/prisma-schema-wasm to run schema contract tests';
const enums = dm ? Object.fromEntries(dm.enums.map((e) => [e.name, e.values.map((v) => v.name)])) : {};

/** Members of `export type <name> = 'A' | 'B' …;` in a source file. */
function unionMembers(file, name) {
  const m = read(file).match(new RegExp(`export type ${name}\\s*=([^;]+);`));
  assert.ok(m, `type ${name} not found in ${file}`);
  return [...m[1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}
const sorted = (a) => [...a].sort();

test('schema sanity: 60 models, 67 enums', { skip }, () => {
  assert.equal(dm.models.length, 60);
  assert.equal(dm.enums.length, 67);
});

for (const [file, type, enumName] of [
  ['src/modules/finance/landed-cost.calculator.ts', 'Incoterm', 'Incoterm'],
  ['src/modules/finance/landed-cost.calculator.ts', 'LandedCostComponent', 'LandedCostComponent'],
  ['src/modules/finance/landed-cost.calculator.ts', 'AllocationBasis', 'AllocationBasis'],
  ['src/modules/consignment/workflow.ts', 'WorkflowStage', 'WorkflowStage'],
  ['src/modules/consignment/workflow.ts', 'WorkflowStepCode', 'WorkflowStepCode'],
  ['src/modules/consignment/workflow.ts', 'StepStatus', 'StepStatus'],
]) {
  test(`${type} union equals schema enum ${enumName}`, { skip }, () => {
    assert.ok(enums[enumName], `enum ${enumName} missing from schema`);
    assert.deepEqual(sorted(unionMembers(file, type)), sorted(enums[enumName]));
  });
}

test('StepScope union matches the ConsignmentStep subject columns', () => {
  assert.deepEqual(sorted(unionMembers('src/modules/consignment/workflow.ts', 'StepScope')), ['BATCH', 'PURCHASE_ORDER', 'SHIPMENT', 'VENDOR']);
});

test('ConsignmentStep has exactly the four nullable subject FKs the workflow maps to', { skip }, () => {
  const model = dm.models.find((m) => m.name === 'ConsignmentStep');
  for (const col of ['vendorId', 'purchaseOrderId', 'batchId', 'shipmentId']) {
    const f = model.fields.find((x) => x.name === col);
    assert.ok(f && !f.isRequired, `${col} must exist and be optional`);
  }
});

test('every UPPER_SNAKE literal the logistics/consignment code writes is a real enum value', { skip }, () => {
  const all = new Set(Object.values(enums).flat());
  // Literals that are intentionally not Prisma enum values (HTTP codes, error codes, policy keys, currencies, etc.).
  const allow = new Set(['IN', 'INR', 'USD', 'MARKET', 'CUSTOMS', 'VALUE', 'WEIGHT', 'QUANTITY', 'P2034' /* Prisma tx conflict */, 'REEFER' /* prefix of REEFER_20/40 */, 'SHIPMENT' /* StepScope */, 'SUBMIT', 'APPROVE' /* clearance action keys */, 'SB_FILING', 'BOE_FILING' /* IcegateMessage.messageType is free text */]);
  const files = [
    'src/modules/logistics/services/port-arrival.service.ts',
    'src/modules/consignment/step-tracker.ts',
    'src/modules/logistics/queries/batch-position.ts',
    'src/modules/logistics/services/delivery.service.ts',
    'src/modules/shared/shipment-ops.ts',
    'src/modules/sourcing/services.ts',
    'src/modules/warehouse/services.ts',
    'src/modules/compliance/services.ts',
    'src/modules/customs/services.ts',
    'src/modules/finance/services.ts',
    'src/lib/rbac.ts',
  ];
  const bad = [];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // only literals used as values: after ===, !==, :, =, in [ , or inside arrays
    for (const m of src.matchAll(/(?:===|!==|:|=|\[|,|\()\s*'([A-Z][A-Z0-9_]{2,})'/g)) {
      const lit = m[1];
      if (all.has(lit) || allow.has(lit)) continue;
      // DomainError codes are first args of `new DomainError('CODE', …)`
      if (new RegExp(`DomainError\\(\\s*'${lit}'`).test(src)) continue;
      bad.push(`${f}: ${lit}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], 'literals not found in any schema enum');
});

test('money columns are Decimal (no Float anywhere in the schema)', { skip }, () => {
  const floats = [];
  for (const m of dm.models) for (const f of m.fields) if (f.type === 'Float') floats.push(`${m.name}.${f.name}`);
  assert.deepEqual(floats, []);
});

test('append-only log tables carry no updatedAt column', { skip }, () => {
  for (const name of ['ShipmentTrackingEvent', 'ShipmentStatusHistory', 'ComplianceEvent', 'IcegateMessage', 'FinanceLedgerEntry', 'AuditLog']) {
    const m = dm.models.find((x) => x.name === name);
    assert.ok(m, `${name} missing`);
    assert.ok(!m.fields.some((f) => f.isUpdatedAt), `${name} must be append-only (no @updatedAt)`);
  }
});

test('Shipment keeps its optimistic-lock version and tracking-position columns', { skip }, () => {
  const s = dm.models.find((m) => m.name === 'Shipment');
  for (const c of ['version', 'currentMilestone', 'currentMilestoneAt', 'currentLocationText', 'pgaClearance']) {
    assert.ok(s.fields.some((f) => f.name === c), `Shipment.${c}`);
  }
});

test('granular milestones required by the brief exist', { skip }, () => {
  for (const v of ['IN_TRANSIT_TARMAC', 'PORT_STOCKED_REEFER', 'DISCHARGED_SEA_YARD']) {
    assert.ok(enums.TrackingMilestone.includes(v), v);
  }
});
