/**
 * Landed-cost engine — PURE (no DB, no I/O) so it is deterministic and unit-testable.
 * The caller (e.g. port-arrival.service) loads data, resolves FX, and persists the result.
 *
 * Per shipment item the engine layers, in INR:
 *   product cost + freight + insurance + BCD + SWS + additional duty + IGST
 *   + port/terminal/CFS/brokerage/inland/bank charges + demurrage/detention
 * Shipment-level charges are allocated across items (VALUE | WEIGHT | QUANTITY) with the
 * largest-remainder method so item lines always sum EXACTLY to the posted charge.
 *
 * Recoverable taxes (IGST, when the entity can take input credit) are emitted as lines flagged
 * `isRecoverable` and EXCLUDED from landed unit cost, but reported separately.
 */
import { Decimal } from '@prisma/client/runtime/library';
import { D, ZERO, allocate, round2, round4, sum } from '../../lib/money';

// String unions mirror the Prisma enums structurally (keeps this file free of generated-client imports).
export type Incoterm = 'EXW' | 'FCA' | 'FAS' | 'FOB' | 'CFR' | 'CIF' | 'CPT' | 'CIP' | 'DAP' | 'DPU' | 'DDP';
export type AllocationBasis = 'VALUE' | 'WEIGHT' | 'QUANTITY';
export type LandedCostComponent =
  | 'PRODUCT_COST'
  | 'FREIGHT'
  | 'INSURANCE'
  | 'BASIC_CUSTOMS_DUTY'
  | 'SOCIAL_WELFARE_SURCHARGE'
  | 'ADDITIONAL_DUTY'
  | 'IGST'
  | 'PORT_HANDLING'
  | 'TERMINAL_HANDLING'
  | 'CFS_CHARGES'
  | 'CUSTOMS_BROKERAGE'
  | 'INLAND_TRANSPORT'
  | 'BANK_CHARGES'
  | 'DEMURRAGE'
  | 'DETENTION'
  | 'OTHER';

/** MARKET = commercial rate for cost lines; CUSTOMS = notified rate for assessable value. Returns INR per 1 unit. */
export type FxKind = 'MARKET' | 'CUSTOMS';
export type FxLookup = (currency: string, kind: FxKind) => Decimal;

/** Components produced by the engine itself; posted charges of these types are ignored by callers. */
export const COMPUTED_COMPONENTS: ReadonlySet<LandedCostComponent> = new Set<LandedCostComponent>([
  'PRODUCT_COST',
  'BASIC_CUSTOMS_DUTY',
  'SOCIAL_WELFARE_SURCHARGE',
  'ADDITIONAL_DUTY',
  'IGST',
]);

export interface DutyRates {
  bcdRate: Decimal; // % of assessable value
  swsRate: Decimal; // % OF BCD
  additionalDutyRate: Decimal; // % of assessable value
  igstRate: Decimal; // % of (AV + BCD + SWS + additional)
}

export interface CalcItemInput {
  shipmentItemId: number;
  hsCode: string;
  quantity: Decimal;
  unitPrice: Decimal; // transaction price, in invoiceCurrency
  unitCostInr: Decimal; // product cost basis, INR
  netWeightKg: Decimal | null;
  duty: DutyRates | null;
}

export interface CalcChargeInput {
  component: LandedCostComponent;
  amount: Decimal;
  currency: string;
  basis: AllocationBasis;
  isEstimated: boolean;
  description?: string;
}

export interface CalcPolicy {
  jurisdiction: string;
  incoterm: Incoterm;
  igstRecoverable: boolean;
  /** % of CIF added to assessable value as landing charges (India: 1). 0 disables. */
  landingChargePct: Decimal;
  /** % of invoice value assumed as insurance when none is posted and the Incoterm excludes it. null disables. */
  defaultInsurancePctOfFob: Decimal | null;
}

export interface CalcInput {
  items: CalcItemInput[];
  charges: CalcChargeInput[];
  invoiceCurrency: string;
  policy: CalcPolicy;
  fx: FxLookup;
}

export interface CalcLine {
  shipmentItemId: number;
  component: LandedCostComponent;
  description: string | null;
  originalAmount: Decimal;
  currency: string;
  fxRate: Decimal;
  amountInr: Decimal;
  isRecoverable: boolean;
  isEstimated: boolean;
}

export interface DutyBreakdown {
  assessableValueInr: Decimal;
  bcd: Decimal;
  sws: Decimal;
  additionalDuty: Decimal;
  igst: Decimal;
}

export interface CalcItemResult {
  shipmentItemId: number;
  quantity: Decimal;
  totalInr: Decimal; // landed total, excl. recoverable taxes
  recoverableTaxInr: Decimal;
  landedUnitCostInr: Decimal;
  duty: DutyBreakdown | null;
}

export interface CalcResult {
  lines: CalcLine[];
  items: CalcItemResult[];
  totalInr: Decimal;
  recoverableTaxInr: Decimal;
  hasEstimates: boolean;
  warnings: string[];
}

/** Incoterms under which the invoice price does NOT already include freight to the destination. */
const FREIGHT_NOT_IN_PRICE: ReadonlySet<Incoterm> = new Set<Incoterm>(['EXW', 'FCA', 'FAS', 'FOB']);
/** Incoterms under which the invoice price does NOT already include insurance. */
const INSURANCE_NOT_IN_PRICE: ReadonlySet<Incoterm> = new Set<Incoterm>(['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CPT']);

/** Whole days beyond free time, counting any started day (ceil). Pure helper for demurrage accrual. */
export function accruedDemurrageDays(freeTimeStart: Date, asOf: Date, freeDays: number): number {
  const elapsed = Math.ceil((asOf.getTime() - freeTimeStart.getTime()) / 86_400_000);
  return Math.max(0, elapsed - freeDays);
}

export function calculateLandedCost(input: CalcInput): CalcResult {
  const { items, charges, invoiceCurrency, policy, fx } = input;
  if (items.length === 0) throw new Error('calculateLandedCost: shipment has no items');

  const warnings = new Set<string>();
  const lines: CalcLine[] = [];

  // ── 1. Base values per item ────────────────────────────────────────────────
  const invoiceFxCustoms = fx(invoiceCurrency, 'CUSTOMS');
  const base = items.map((it) => ({
    it,
    invoiceValueInr: round2(it.quantity.times(it.unitPrice).times(invoiceFxCustoms)), // customs-rate basis
    productCostInr: round2(it.quantity.times(it.unitCostInr)),
  }));

  const weightsFor = (basis: AllocationBasis): Decimal[] => {
    if (basis === 'QUANTITY') return items.map((i) => i.quantity);
    if (basis === 'WEIGHT') {
      if (items.every((i) => i.netWeightKg !== null && i.netWeightKg.gt(0))) {
        return items.map((i) => i.netWeightKg as Decimal);
      }
      warnings.add('WEIGHT allocation requested but net weights are missing on some items; fell back to VALUE.');
    }
    return base.map((b) => b.invoiceValueInr);
  };

  // ── 2. Product cost lines ──────────────────────────────────────────────────
  for (const b of base) {
    lines.push({
      shipmentItemId: b.it.shipmentItemId,
      component: 'PRODUCT_COST',
      description: `${b.it.quantity.toString()} × ${b.it.unitCostInr.toString()} INR`,
      originalAmount: b.productCostInr,
      currency: 'INR',
      fxRate: D(1),
      amountInr: b.productCostInr,
      isRecoverable: false,
      isEstimated: false,
    });
  }

  // ── 3. Posted charges, allocated to items (market FX) ──────────────────────
  for (const c of charges) {
    const w = weightsFor(c.basis);
    const rate = fx(c.currency, 'MARKET');
    const inrParts = allocate(round2(c.amount.times(rate)), w);
    const origParts = allocate(c.amount, w);
    items.forEach((it, i) => {
      if (inrParts[i].isZero() && origParts[i].isZero()) return;
      lines.push({
        shipmentItemId: it.shipmentItemId,
        component: c.component,
        description: c.description ?? null,
        originalAmount: origParts[i],
        currency: c.currency,
        fxRate: rate,
        amountInr: inrParts[i],
        isRecoverable: false,
        isEstimated: c.isEstimated,
      });
    });
  }

  // ── 4. Assessable value (customs-notified FX) ──────────────────────────────
  const addFreight = FREIGHT_NOT_IN_PRICE.has(policy.incoterm);
  const addInsurance = INSURANCE_NOT_IN_PRICE.has(policy.incoterm);

  const avFreight = items.map(() => ZERO);
  let avInsurance = items.map(() => ZERO);
  let valuationEstimated = false;

  for (const c of charges) {
    if (c.component !== 'FREIGHT' && c.component !== 'INSURANCE') continue;
    const parts = allocate(round2(c.amount.times(fx(c.currency, 'CUSTOMS'))), weightsFor(c.basis));
    const target = c.component === 'FREIGHT' ? avFreight : avInsurance;
    parts.forEach((p, i) => (target[i] = target[i].plus(p)));
    if (c.isEstimated) valuationEstimated = true;
  }

  if (addFreight && !charges.some((c) => c.component === 'FREIGHT')) {
    warnings.add('No freight posted for an Incoterm that excludes it; assessable value is understated until freight is entered.');
    valuationEstimated = true;
  }
  if (addInsurance && !charges.some((c) => c.component === 'INSURANCE') && policy.defaultInsurancePctOfFob) {
    const totalInvoice = sum(base.map((b) => b.invoiceValueInr));
    const synthetic = round2(totalInvoice.times(policy.defaultInsurancePctOfFob).div(100));
    avInsurance = allocate(synthetic, base.map((b) => b.invoiceValueInr));
    warnings.add(`No insurance posted; valuation assumes ${policy.defaultInsurancePctOfFob.toString()}% of invoice value.`);
    valuationEstimated = true;
  }

  // ── 5. Duties per item ─────────────────────────────────────────────────────
  const landingFactor = D(1).plus(policy.landingChargePct.div(100));
  let missingDuty = false;

  const duties: (DutyBreakdown | null)[] = base.map((b, i) => {
    const d = items[i].duty;
    const preLanding = b.invoiceValueInr
      .plus(addFreight ? avFreight[i] : ZERO)
      .plus(addInsurance ? avInsurance[i] : ZERO);
    const av = round2(preLanding.times(landingFactor));

    if (!d) {
      warnings.add(`No duty rate on file for HS ${items[i].hsCode} in ${policy.jurisdiction}; duty and tax assumed 0.`);
      missingDuty = true;
      return null;
    }
    const bcd = round2(av.times(d.bcdRate).div(100));
    const sws = round2(bcd.times(d.swsRate).div(100));
    const additionalDuty = round2(av.times(d.additionalDutyRate).div(100));
    const igst = round2(av.plus(bcd).plus(sws).plus(additionalDuty).times(d.igstRate).div(100));
    return { assessableValueInr: av, bcd, sws, additionalDuty, igst };
  });

  const pushDuty = (shipmentItemId: number, component: LandedCostComponent, amount: Decimal, note: string, recoverable = false) => {
    if (amount.isZero()) return;
    lines.push({
      shipmentItemId,
      component,
      description: note,
      originalAmount: amount,
      currency: 'INR',
      fxRate: D(1),
      amountInr: amount,
      isRecoverable: recoverable,
      isEstimated: valuationEstimated,
    });
  };

  duties.forEach((d, i) => {
    if (!d) return;
    const id = items[i].shipmentItemId;
    const r = items[i].duty as DutyRates;
    pushDuty(id, 'BASIC_CUSTOMS_DUTY', d.bcd, `BCD ${r.bcdRate.toString()}% on AV ${d.assessableValueInr.toFixed(2)}`);
    pushDuty(id, 'SOCIAL_WELFARE_SURCHARGE', d.sws, `SWS ${r.swsRate.toString()}% of BCD`);
    pushDuty(id, 'ADDITIONAL_DUTY', d.additionalDuty, `Additional duty ${r.additionalDutyRate.toString()}% on AV`);
    pushDuty(id, 'IGST', d.igst, `IGST ${r.igstRate.toString()}% on AV + duties`, policy.igstRecoverable);
  });

  // ── 6. Roll up ─────────────────────────────────────────────────────────────
  const itemResults: CalcItemResult[] = items.map((it, i) => {
    const mine = lines.filter((l) => l.shipmentItemId === it.shipmentItemId);
    const total = sum(mine.filter((l) => !l.isRecoverable).map((l) => l.amountInr));
    const recoverable = sum(mine.filter((l) => l.isRecoverable).map((l) => l.amountInr));
    return {
      shipmentItemId: it.shipmentItemId,
      quantity: it.quantity,
      totalInr: total,
      recoverableTaxInr: recoverable,
      landedUnitCostInr: it.quantity.isZero() ? ZERO : round4(total.div(it.quantity)),
      duty: duties[i],
    };
  });

  return {
    lines,
    items: itemResults,
    totalInr: sum(itemResults.map((r) => r.totalInr)),
    recoverableTaxInr: sum(itemResults.map((r) => r.recoverableTaxInr)),
    hasEstimates: charges.some((c) => c.isEstimated) || valuationEstimated || missingDuty,
    warnings: [...warnings],
  };
}
