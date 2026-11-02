import assert from 'node:assert/strict';
import test from 'node:test';
import { allocate, D } from '../../lib/money';
import {
  accruedDemurrageDays,
  calculateLandedCost,
  type CalcInput,
  type FxLookup,
} from './landed-cost.calculator';

const fx: FxLookup = (ccy, kind) => {
  if (ccy === 'INR') return D(1);
  if (ccy === 'USD') return kind === 'CUSTOMS' ? D('83.00') : D('83.10');
  throw new Error(`no fx for ${ccy}`);
};

const baseInput = (): CalcInput => ({
  invoiceCurrency: 'USD',
  fx,
  policy: {
    jurisdiction: 'IN',
    incoterm: 'FOB',
    igstRecoverable: true,
    landingChargePct: D(1),
    defaultInsurancePctOfFob: D('1.125'),
  },
  items: [
    {
      shipmentItemId: 1,
      hsCode: '09109100',
      quantity: D(1000),
      unitPrice: D('2.50'),
      unitCostInr: D('150.00'),
      netWeightKg: D(1000),
      duty: { bcdRate: D(10), swsRate: D(10), additionalDutyRate: D(0), igstRate: D(18) },
    },
  ],
  charges: [
    { component: 'FREIGHT', amount: D(300), currency: 'USD', basis: 'VALUE', isEstimated: false },
    { component: 'PORT_HANDLING', amount: D(5000), currency: 'INR', basis: 'VALUE', isEstimated: false },
  ],
});

test('FOB import: assessable value, duty cascade and landed unit cost', () => {
  const r = calculateLandedCost(baseInput());
  const line = (c: string) => r.lines.find((l) => l.component === c)!;

  // AV = (207,500 + 24,900 freight + 2,334.38 default insurance) × 1.01 landing = 237,081.72
  const duty = r.items[0].duty!;
  assert.equal(duty.assessableValueInr.toFixed(2), '237081.72');
  assert.equal(duty.bcd.toFixed(2), '23708.17'); // 10% of AV
  assert.equal(duty.sws.toFixed(2), '2370.82'); // 10% of BCD
  assert.equal(duty.igst.toFixed(2), '47368.93'); // 18% of (AV + BCD + SWS)

  assert.equal(line('PRODUCT_COST').amountInr.toFixed(2), '150000.00');
  assert.equal(line('FREIGHT').amountInr.toFixed(2), '24930.00'); // market FX 83.10
  assert.equal(line('IGST').isRecoverable, true);

  // landed = 150,000 + 24,930 + 5,000 + 23,708.17 + 2,370.82 (IGST excluded: recoverable)
  assert.equal(r.totalInr.toFixed(2), '206008.99');
  assert.equal(r.recoverableTaxInr.toFixed(2), '47368.93');
  assert.equal(r.items[0].landedUnitCostInr.toFixed(4), '206.0090');
  assert.equal(r.hasEstimates, true); // insurance was defaulted
  assert.ok(r.warnings.some((w) => w.includes('insurance')));
});

test('non-recoverable IGST is layered into landed cost', () => {
  const input = baseInput();
  input.policy.igstRecoverable = false;
  const r = calculateLandedCost(input);
  assert.equal(r.recoverableTaxInr.toFixed(2), '0.00');
  assert.ok(r.totalInr.gt(D('250000')));
});

test('missing duty rate yields zero duty, a warning, and an estimate flag', () => {
  const input = baseInput();
  input.items[0].duty = null;
  const r = calculateLandedCost(input);
  assert.equal(r.items[0].duty, null);
  assert.equal(r.hasEstimates, true);
  assert.ok(r.warnings.some((w) => w.includes('No duty rate')));
});

test('CIF terms: freight and insurance are not added to assessable value again', () => {
  const input = baseInput();
  input.policy.incoterm = 'CIF';
  input.charges = [];
  const r = calculateLandedCost(input);
  // 207,500 × 1.01 landing
  assert.equal(r.items[0].duty!.assessableValueInr.toFixed(2), '209575.00');
  assert.equal(r.warnings.length, 0);
});

test('shared charges split across items sum exactly to the posted amount', () => {
  const input = baseInput();
  input.items.push(
    { ...input.items[0], shipmentItemId: 2, quantity: D(333), unitPrice: D('7.77'), netWeightKg: D(333) },
    { ...input.items[0], shipmentItemId: 3, quantity: D(71), unitPrice: D('19.13'), netWeightKg: D(71) },
  );
  input.charges = [{ component: 'PORT_HANDLING', amount: D('10000.01'), currency: 'INR', basis: 'VALUE', isEstimated: false }];
  const r = calculateLandedCost(input);
  const total = r.lines
    .filter((l) => l.component === 'PORT_HANDLING')
    .reduce((a, l) => a.plus(l.amountInr), D(0));
  assert.equal(total.toFixed(2), '10000.01');
});

test('allocate: largest-remainder keeps the cent total exact', () => {
  const parts = allocate(D('100.00'), [D(1), D(1), D(1)]);
  assert.deepEqual(parts.map((p) => p.toFixed(2)), ['33.34', '33.33', '33.33']);
  assert.equal(parts.reduce((a, p) => a.plus(p), D(0)).toFixed(2), '100.00');
});

test('demurrage days count started days beyond free time', () => {
  const start = new Date('2026-11-01T00:00:00Z');
  assert.equal(accruedDemurrageDays(start, new Date('2026-11-01T00:00:00Z'), 5), 0);
  assert.equal(accruedDemurrageDays(start, new Date('2026-11-06T00:00:00Z'), 5), 0);
  assert.equal(accruedDemurrageDays(start, new Date('2026-11-06T06:00:00Z'), 5), 1);
  assert.equal(accruedDemurrageDays(start, new Date('2026-11-09T00:00:00Z'), 5), 3);
});
