import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCOPE_KEY,
  STAGES,
  STEPS,
  STEPS_BY_CODE,
  aggregateStatus,
  stepsInStage,
  unmetPrerequisites,
  validateRegistry,
} from './workflow';

test('registry mirrors the checklist: 6 stages, 23 steps, per-stage counts 4/3/3/5/5/3', () => {
  assert.equal(STAGES.length, 6);
  assert.equal(STEPS.length, 23);
  assert.deepEqual(STAGES.map((s) => stepsInStage(s.stage).length), [4, 3, 3, 5, 5, 3]);
});

test('registry is structurally sound (unique codes, same-scope acyclic prerequisites)', () => {
  assert.deepEqual(validateRegistry(), []);
});

test('every scope maps to a ConsignmentStep subject column', () => {
  for (const s of STEPS) assert.ok(SCOPE_KEY[s.scope], `${s.code} scope`);
  assert.deepEqual(Object.values(SCOPE_KEY).sort(), ['batchId', 'purchaseOrderId', 'shipmentId', 'vendorId']);
});

test('warehouse/compliance steps are batch-scoped; customs & delivery steps are shipment-scoped', () => {
  for (const s of STEPS) {
    if (s.stage === 'WAREHOUSE' || s.stage === 'PACKAGING_COMPLIANCE') assert.equal(s.scope, 'BATCH', s.code);
    if (['EXPORT_CUSTOMS', 'IMPORT_CUSTOMS', 'LAST_MILE'].includes(s.stage)) assert.equal(s.scope, 'SHIPMENT', s.code);
  }
});

test('aggregateStatus rolls subjects up sensibly', () => {
  assert.equal(aggregateStatus([]), 'PENDING');
  assert.equal(aggregateStatus(['DONE', 'DONE']), 'DONE');
  assert.equal(aggregateStatus(['DONE', 'SKIPPED']), 'DONE');
  assert.equal(aggregateStatus(['SKIPPED', 'SKIPPED']), 'SKIPPED');
  assert.equal(aggregateStatus(['DONE', 'PENDING']), 'IN_PROGRESS');
  assert.equal(aggregateStatus(['PENDING', 'PENDING']), 'PENDING');
  assert.equal(aggregateStatus(['DONE', 'BLOCKED', 'PENDING']), 'BLOCKED');
  assert.equal(aggregateStatus(['IN_PROGRESS', 'PENDING']), 'IN_PROGRESS');
});

test('unmetPrerequisites gates DONE transitions', () => {
  assert.deepEqual(unmetPrerequisites('PGA_CLEARANCES', {}), ['BILL_OF_ENTRY_SUBMISSION']);
  assert.deepEqual(unmetPrerequisites('PGA_CLEARANCES', { BILL_OF_ENTRY_SUBMISSION: 'DONE' }), []);
  assert.deepEqual(unmetPrerequisites('PGA_CLEARANCES', { BILL_OF_ENTRY_SUBMISSION: 'SKIPPED' }), []);
  assert.deepEqual(unmetPrerequisites('SHIPPING_BILL_FILING', {}), []);
  assert.equal(STEPS_BY_CODE.LANDED_COST_CONSOLIDATION.dependsOn[0], 'DUTY_ASSESSMENT_OOC');
});
