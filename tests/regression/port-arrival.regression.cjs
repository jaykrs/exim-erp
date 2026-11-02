// Runtime smoke test of port-arrival.service (+ step-tracker) against a RECORDING FAKE of the Prisma client.
// Verifies orchestration logic (guards, ordering, what gets written) — NOT SQL/DB behaviour.
const path = require('path');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
process.chdir(ROOT);
process.env.TSX_TSCONFIG_PATH = path.join(ROOT, 'tsconfig.json');
require(path.join(ROOT, 'node_modules/tsx/dist/cjs/index.cjs'));
const { Decimal } = require(path.join(ROOT, 'node_modules/@prisma/client/runtime/library'));
const d = (v) => new Decimal(v);

class KnownErr extends Error { constructor(m, code) { super(m); this.code = code; } }
let calls; let scenario;

function makeTx() {
  const rec = (name, ret) => async (arg) => { calls.push([name, arg]); return typeof ret === 'function' ? ret(arg) : ret; };
  let clearanceSeq = 0;
  return {
    shipment: { findUnique: rec('shipment.findUnique', () => scenario.shipment), updateMany: rec('shipment.updateMany', () => ({ count: scenario.moveCount ?? 1 })), update: rec('shipment.update', {}) },
    container: { update: rec('container.update', {}) },
    airShipmentDetail: { update: rec('air.update', {}) },
    temperatureReading: { create: rec('temp.create', {}) },
    hsDutyRate: { findMany: rec('hsDutyRate.findMany', () => scenario.dutyRates) },
    exchangeRate: { findMany: rec('exchangeRate.findMany', () => scenario.fxRows) },
    landedCostSheet: {
      updateMany: rec('sheet.updateMany', {}),
      aggregate: rec('sheet.aggregate', { _max: { versionNo: null } }),
      create: rec('sheet.create', (a) => ({ id: 55, versionNo: a.data.versionNo, status: a.data.status })),
      findFirst: rec('sheet.findFirst', null),
    },
    landedCostLine: { createMany: rec('line.createMany', {}) },
    landedCostItem: { createMany: rec('item.createMany', {}) },
    hsRegulatoryRule: { findMany: rec('rule.findMany', () => scenario.rules) },
    regulatoryClearance: { create: rec('clearance.create', () => ({ id: ++clearanceSeq })), findMany: rec('clearance.findMany', []) },
    complianceEvent: { create: rec('complianceEvent.create', {}) },
    customsHold: { create: rec('hold.create', { id: 9 }), findFirst: rec('hold.findFirst', null) },
    shipmentTrackingEvent: { createMany: rec('tracking.createMany', {}) },
    batch: { updateMany: rec('batch.updateMany', {}) },
    shipmentStatusHistory: { create: rec('history.create', {}) },
    auditLog: { create: rec('audit.create', {}) },
    consignmentStep: {
      findMany: rec('step.findMany', []),
      findFirst: rec('step.findFirst', () => scenario.existingStep ?? null),
      create: rec('step.create', { id: 77 }),
      update: rec('step.update', {}),
    },
  };
}

const fakeClient = {
  Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' }, PrismaClientKnownRequestError: KnownErr },
  PrismaClient: class { $transaction(fn) { return fn(makeTx()); } },
};
const clientPath = require.resolve('@prisma/client', { paths: [ROOT] });
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: fakeClient };
const { processPortArrival } = require(path.join(ROOT, 'src/modules/logistics/services/port-arrival.service.ts'));

const today = new Date('2026-11-01T12:00:00Z');
const baseShipment = () => ({
  id: 7, direction: 'EXPORT', mode: 'SEA', incoterm: 'FOB', status: 'GATED_IN', version: 3,
  polId: 1, podId: 2, requiresColdChain: true, invoiceCurrencyCode: 'USD', currentMilestone: null,
  pol: { id: 1, name: 'Nhava Sheva', countryCode: 'IN' }, pod: { id: 2, name: 'Rotterdam', countryCode: 'NL' },
  seaDetail: { terminalName: 'JNPCT' }, airDetail: null, clearances: [],
  containers: [{ id: 31, containerNo: 'MSKU1234567', containerType: 'REEFER_20', yardStackingType: 'STANDARD', yardSlot: null, reeferSetPointC: d('2'), freeDays: 5, demurrageRatePerDay: d('2500'), freeTimeStartAt: null, gatedInAt: null }],
  items: [
    { id: 101, batchId: 11, containerId: 31, hsCodeId: 1, hsCode: { code: '09109100' }, quantity: d(1000), unitPrice: d('2.50'), unitCostInr: d('150'), netWeightKg: d(1000) },
    { id: 102, batchId: 12, containerId: 31, hsCodeId: 2, hsCode: { code: '21069099' }, quantity: d(500), unitPrice: d('4.00'), unitCostInr: d('210'), netWeightKg: d(500) },
  ],
  charges: [
    { id: 1, component: 'FREIGHT', amount: d(1200), currencyCode: 'USD', allocationBasis: 'VALUE', isEstimated: false, description: 'Ocean freight', containerId: null },
    { id: 2, component: 'TERMINAL_HANDLING', amount: d(8000), currencyCode: 'INR', allocationBasis: 'VALUE', isEstimated: false, description: null, containerId: null },
    { id: 3, component: 'BASIC_CUSTOMS_DUTY', amount: d(1), currencyCode: 'INR', allocationBasis: 'VALUE', isEstimated: false, description: null, containerId: null },
  ],
});
const freshScenario = () => ({
  shipment: baseShipment(),
  fxRows: [
    { fromCurrency: 'USD', source: 'RBI_REFERENCE', rate: d('83.10'), effectiveDate: new Date('2026-10-31') },
    { fromCurrency: 'USD', source: 'CUSTOMS_NOTIFIED', rate: d('83.00'), effectiveDate: new Date('2026-10-28') },
  ],
  dutyRates: [{ hsCodeId: 1, bcdRate: d(5), swsRate: d(0), additionalDutyRate: d(0), igstRate: d(21) }], // hs 2 deliberately missing
  rules: [
    { id: 1, hsPrefix: '09', board: 'FSSAI', scope: 'EXPORT', isMandatory: true, leadTimeDays: 3, description: null },
    { id: 2, hsPrefix: '0910', board: 'PLANT_QUARANTINE', scope: 'BOTH', isMandatory: true, leadTimeDays: 2, description: null },
    { id: 3, hsPrefix: '21', board: 'FSSAI', scope: 'EXPORT', isMandatory: false, leadTimeDays: null, description: 'label check' },
  ],
});
const importScenario = () => {
  const s = freshScenario();
  Object.assign(s.shipment, {
    direction: 'IMPORT', status: 'IN_TRANSIT', requiresColdChain: false, containers: [],
    pol: { id: 1, name: 'Rotterdam', countryCode: 'NL' }, pod: { id: 2, name: 'Nhava Sheva', countryCode: 'IN' },
    charges: [{ id: 9, component: 'FREIGHT', amount: d(900), currencyCode: 'USD', allocationBasis: 'VALUE', isEstimated: false, description: null, containerId: null }],
    // two graded child lots of the SAME batch 21 → must be logged once
    items: [
      { id: 201, batchId: 21, containerId: null, hsCodeId: 1, hsCode: { code: '85171300' }, quantity: d(100), unitPrice: d('120'), unitCostInr: d('9000'), netWeightKg: d(50) },
      { id: 202, batchId: 21, containerId: null, hsCodeId: 1, hsCode: { code: '85171300' }, quantity: d(40), unitPrice: d('90'), unitCostInr: d('7000'), netWeightKg: d(20) },
    ],
  });
  s.dutyRates = [{ hsCodeId: 1, bcdRate: d(20), swsRate: d(10), additionalDutyRate: d(0), igstRate: d(18) }];
  s.rules = [{ id: 4, hsPrefix: '85', board: 'BIS', scope: 'IMPORT', isMandatory: true, leadTimeDays: 5, description: null }];
  return s;
};
const count = (n) => calls.filter(([k]) => k === n).length;
const first = (n) => calls.find(([k]) => k === n)[1];
const sumNonRecoverable = (lines) => lines.filter((l) => !l.isRecoverable).reduce((a, l) => a.plus(l.amountInr), d(0));

(async () => {
  // 1. EXPORT happy path
  calls = []; scenario = freshScenario();
  const r = await processPortArrival({ shipmentId: 7, arrivedAt: new Date('2026-11-01T08:00:00Z'), actorId: 5, temperatureC: 5.5, asOf: today, containers: [{ containerNo: 'MSKU1234567', yardSlot: 'C4-12-02-3' }] });
  assert.equal(r.status, 'CUSTOMS_HOLD'); assert.equal(r.alreadyProcessed, false);
  assert.equal(r.milestone, 'PGA_CLEARANCE_PENDING');
  assert.deepEqual(r.compliance.map((c) => c.board).sort(), ['FSSAI', 'PLANT_QUARANTINE']);
  assert.ok(r.compliance.every((c) => c.blocking && c.newlyTriggered));
  assert.equal(r.hold.reason, 'PGA_PENDING');
  assert.equal(r.landedCost.status, 'PROVISIONAL');
  assert.equal(count('clearance.create'), 2); assert.equal(count('complianceEvent.create'), 2);
  assert.deepEqual(first('shipment.updateMany').where, { id: 7, version: 3, status: 'GATED_IN' });
  assert.equal(first('shipment.updateMany').data.status, 'CUSTOMS_HOLD');
  assert.equal(first('shipment.update').data.pgaClearance, 'PENDING');
  assert.equal(first('history.create').data.toStatus, 'CUSTOMS_HOLD');
  const ev = first('tracking.createMany').data;
  assert.equal(ev.length, 9);
  assert.equal(ev[0].milestone, 'PORT_STOCKED_REEFER');
  assert.equal(first('container.update').data.yardStackingType, 'REEFER_PLUGGED');
  assert.equal(first('batch.updateMany').data.currentMilestone, 'PGA_CLEARANCE_PENDING');
  const step = first('step.create').data;
  assert.deepEqual([step.stepCode, step.status, step.stage, step.shipmentId], ['PORT_TERMINAL_HANDLING_LOADING', 'IN_PROGRESS', 'EXPORT_CUSTOMS', 7]);
  const lines = first('line.createMany').data;
  assert.equal(sumNonRecoverable(lines).toFixed(2), r.landedCost.totalInr);
  const freight = lines.filter((l) => l.component === 'FREIGHT').reduce((a, l) => a.plus(l.amountInr), d(0));
  assert.equal(freight.toFixed(2), '99720.00');
  assert.ok(r.warnings.some((w) => w.includes('BASIC_CUSTOMS_DUTY charge #3 ignored')));
  assert.ok(r.warnings.some((w) => w.includes('No duty rate on file for HS 21069099')));
  assert.ok(r.warnings.some((w) => w.includes('outside the configured range')));
  const order = calls.map(([k]) => k);
  assert.ok(order.indexOf('shipment.updateMany') < order.indexOf('sheet.create'));
  assert.ok(order.indexOf('history.create') > order.indexOf('hold.create'));
  console.log('PASS export happy path        total INR', r.landedCost.totalInr);

  // 2. IMPORT: CUSTOMS_IMPORT_HOLD, India duty jurisdiction, BIS trigger, graded lots logged once
  calls = []; scenario = importScenario();
  const im = await processPortArrival({ shipmentId: 7, arrivedAt: new Date('2026-11-01T06:00:00Z'), actorId: 5, asOf: today });
  assert.equal(im.status, 'CUSTOMS_IMPORT_HOLD');
  assert.equal(first('hsDutyRate.findMany').where.countryCode, 'IN');
  assert.deepEqual(im.compliance.map((c) => c.board), ['BIS']);
  assert.equal(im.milestone, 'PGA_CLEARANCE_PENDING');
  const iev = first('tracking.createMany').data;
  assert.equal(iev.length, 6, '3 milestones × (1 shipment + 1 batch) — two graded lots of batch 21 logged once');
  assert.equal(iev[0].milestone, 'DISCHARGED_SEA_YARD');
  const upd = first('shipment.update').data;
  assert.ok(upd.ata instanceof Date); assert.equal(upd.pgaClearance, 'PENDING');
  assert.equal(first('step.create').data.stepCode, 'PGA_CLEARANCES');
  assert.equal(first('history.create').data.toStatus, 'CUSTOMS_IMPORT_HOLD');
  const ilines = first('line.createMany').data;
  assert.ok(ilines.find((l) => l.component === 'IGST').isRecoverable);
  assert.ok(!ilines.some((l) => l.component === 'PRODUCT_COST' && l.shipmentItemId === 0));
  assert.equal(sumNonRecoverable(ilines).toFixed(2), im.landedCost.totalInr);
  assert.ok(im.warnings.some((w) => w.includes('insurance')));
  console.log('PASS import → CUSTOMS_IMPORT_HOLD  total INR', im.landedCost.totalInr, '| recoverable IGST', im.landedCost.recoverableTaxInr);

  // 3. idempotent replay (both hold statuses)
  for (const status of ['CUSTOMS_HOLD', 'CUSTOMS_IMPORT_HOLD']) {
    calls = []; scenario = freshScenario(); scenario.shipment.status = status;
    const again = await processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today });
    assert.equal(again.alreadyProcessed, true); assert.equal(again.status, status);
    assert.equal(count('shipment.updateMany'), 0); assert.equal(count('tracking.createMany'), 0);
  }
  console.log('PASS idempotent replay writes nothing (both hold statuses)');

  // 4. invalid transitions
  for (const [direction, status] of [['EXPORT', 'DRAFT'], ['EXPORT', 'IN_TRANSIT'], ['IMPORT', 'CUSTOMS_RELEASED']]) {
    calls = []; scenario = freshScenario(); Object.assign(scenario.shipment, { direction, status });
    await assert.rejects(() => processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today }), (e) => e.code === 'INVALID_TRANSITION' && e.httpStatus === 409);
  }
  console.log('PASS invalid transitions → 409');

  // 5. export may arrive after LEO is granted (checklist Stage 4 order)
  calls = []; scenario = freshScenario(); scenario.shipment.status = 'EXPORT_LEO_GRANTED';
  assert.equal((await processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today })).status, 'CUSTOMS_HOLD');
  console.log('PASS EXPORT_LEO_GRANTED → arrival allowed');

  // 6. optimistic lock, FX, unknown container
  calls = []; scenario = freshScenario(); scenario.moveCount = 0;
  await assert.rejects(() => processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today }), (e) => e.code === 'CONCURRENT_UPDATE');
  assert.equal(count('sheet.create'), 0);
  calls = []; scenario = freshScenario(); scenario.fxRows = [];
  await assert.rejects(() => processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today }), (e) => e.code === 'FX_RATE_MISSING');
  calls = []; scenario = freshScenario();
  await assert.rejects(() => processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today, containers: [{ containerNo: 'ZZZZ0000000' }] }), (e) => e.code === 'UNKNOWN_CONTAINER');
  console.log('PASS version conflict → 409 · missing FX → 422 · unknown container → 422');

  // 7. a step already DONE is never regressed by the automated update
  calls = []; scenario = freshScenario(); scenario.existingStep = { id: 5, status: 'DONE' };
  await processPortArrival({ shipmentId: 7, arrivedAt: today, asOf: today });
  assert.equal(count('step.update'), 0); assert.equal(count('step.create'), 0);
  console.log('PASS DONE checklist step not regressed');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
