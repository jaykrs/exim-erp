/**
 * Port arrival processing — one atomic business operation across ~12 tables:
 *
 *   1. guard the state machine (+ optimistic lock on Shipment.version)
 *   2. record gate-in / yard / cold-chain data on containers and air detail
 *   3. compute the itemised landed cost (pure calculator) and persist a new versioned sheet
 *   4. evaluate HS-code regulatory rules (FSSAI / BIS / CDSCO / quarantine …),
 *      open a RegulatoryClearance per required board and log a ComplianceEvent
 *   5. place a CustomsHold and move the shipment to its hold status:
 *        EXPORT → CUSTOMS_HOLD            IMPORT → CUSTOMS_IMPORT_HOLD (checklist Stage 5)
 *   6. append tracking events (shipment + every batch) and refresh Batch "current position";
 *      roll PGA state up onto Shipment.pgaClearance and advance the checklist step
 *   7. append ShipmentStatusHistory + AuditLog
 *
 * Everything runs in ONE interactive transaction: either all of it commits or none of it does.
 * The operation is idempotent: re-submitting for a shipment already on hold is a no-op read.
 */
import { Prisma } from '@prisma/client';
import type { ClearanceBoard, ClearanceStatus, TrackingMilestone, YardStackingType } from '@prisma/client';
import { DomainError } from '@/lib/errors';
import { D, Decimal } from '@/lib/money';
import { prisma } from '@/lib/prisma';
import { recordStep } from '@/modules/consignment/step-tracker';
import {
  COMPUTED_COMPONENTS,
  accruedDemurrageDays,
  calculateLandedCost,
  type CalcChargeInput,
  type CalcItemInput,
  type DutyRates,
  type FxKind,
  type FxLookup,
} from '@/modules/finance/landed-cost.calculator';

type Tx = Prisma.TransactionClient;

// ── Configuration ────────────────────────────────────────────────────────────
/** Statuses from which a port arrival may be processed, by trade direction. */
const ARRIVAL_ALLOWED_FROM: Record<'EXPORT' | 'IMPORT', readonly string[]> = {
  EXPORT: ['BOOKED', 'GATED_IN', 'AT_PORT', 'EXPORT_LEO_GRANTED'],
  IMPORT: ['BOOKED', 'IN_TRANSIT', 'AT_PORT'],
};

/** Status a shipment is parked in while customs / PGA clearance is pending, by trade direction. */
const HOLD_STATUS = { EXPORT: 'CUSTOMS_HOLD', IMPORT: 'CUSTOMS_IMPORT_HOLD' } as const;

/**
 * Customs valuation add-ons by importing jurisdiction. These reflect the commonly applied
 * Indian valuation conventions — CONFIRM against current CBIC notifications / your CHA before
 * relying on them for filings. Jurisdictions not listed use CIF with no add-ons; add an entry
 * (or a FOB-basis switch, e.g. for the US) when you ship there.
 */
const VALUATION_POLICY: Record<string, { landingChargePct: string; defaultInsurancePctOfFob: string | null }> = {
  IN: { landingChargePct: '1', defaultInsurancePctOfFob: '1.125' },
};
const DEFAULT_VALUATION = { landingChargePct: '0', defaultInsurancePctOfFob: null };

const REEFER_TOLERANCE_C = 2; // ± around a sea-reefer set point before a reading counts as an excursion
const FX_FRESHNESS_DAYS = 45;

// ── Public contract ──────────────────────────────────────────────────────────
export interface PortArrivalInput {
  shipmentId: number;
  arrivedAt: Date;
  actorId?: number;
  /** Defaults to POL for exports, POD for imports. */
  terminalLocationId?: number;
  locationText?: string;
  /** Gate-in temperature (reefer / cold-chain air). */
  temperatureC?: number;
  containers?: { containerNo: string; yardSlot?: string; stackingType?: YardStackingType }[];
  /** Entity can claim input credit on IGST (default true). */
  igstRecoverable?: boolean;
  /** Evaluation time for FX, duty rates and demurrage (default: now). Mainly for tests. */
  asOf?: Date;
}

export interface PortArrivalResult {
  alreadyProcessed: boolean;
  shipmentId: number;
  status: 'CUSTOMS_HOLD' | 'CUSTOMS_IMPORT_HOLD';
  milestone: TrackingMilestone | null;
  landedCost: {
    sheetId: number;
    versionNo: number;
    status: string;
    totalInr: string;
    recoverableTaxInr: string;
    items: { shipmentItemId: number; quantity: string; totalInr: string; landedUnitCostInr: string }[];
  } | null;
  hold: { id: number; reason: string } | null;
  compliance: { board: ClearanceBoard; status: ClearanceStatus; newlyTriggered: boolean; blocking: boolean }[];
  warnings: string[];
}

// ── Entry point (with deadlock/write-conflict retry) ─────────────────────────
export async function processPortArrival(input: PortArrivalInput): Promise<PortArrivalResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction((tx) => run(tx, input), {
        maxWait: 5_000,
        timeout: 30_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (e) {
      const retryable = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034';
      if (!retryable || attempt >= 3) throw e;
    }
  }
}

// ── Transaction body ─────────────────────────────────────────────────────────
async function run(tx: Tx, input: PortArrivalInput): Promise<PortArrivalResult> {
  const { shipmentId, arrivedAt, actorId } = input;
  const asOf = input.asOf ?? new Date();
  const warnings: string[] = [];

  const shipment = await tx.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      pol: true,
      pod: true,
      items: { include: { hsCode: true } },
      containers: true,
      seaDetail: true,
      airDetail: true,
      charges: true,
      clearances: true,
    },
  });
  if (!shipment) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${shipmentId} does not exist.`, 404);

  // Idempotency: already processed → return current state, write nothing.
  if (shipment.status === 'CUSTOMS_HOLD' || shipment.status === 'CUSTOMS_IMPORT_HOLD') {
    return loadExisting(tx, shipment.id, shipment.status, shipment.currentMilestone);
  }

  if (!ARRIVAL_ALLOWED_FROM[shipment.direction].includes(shipment.status)) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `A ${shipment.direction} shipment in status ${shipment.status} cannot be processed as a port arrival.`,
      409,
    );
  }
  if (shipment.items.length === 0) {
    throw new DomainError('NO_ITEMS', 'Shipment has no items; nothing to cost or clear.', 422);
  }

  const arrivalLocationId = input.terminalLocationId ?? (shipment.direction === 'EXPORT' ? shipment.polId : shipment.podId);
  const arrivalPort = shipment.direction === 'EXPORT' ? shipment.pol : shipment.pod;

  // 1 ─ Optimistic state change first, so a concurrent writer fails fast and rolls everything back.
  const holdStatus = HOLD_STATUS[shipment.direction];
  const moved = await tx.shipment.updateMany({
    where: { id: shipment.id, version: shipment.version, status: shipment.status },
    data: { status: holdStatus, version: { increment: 1 } },
  });
  if (moved.count !== 1) {
    throw new DomainError('CONCURRENT_UPDATE', 'Shipment was modified by someone else; reload and retry.', 409);
  }

  // 2 ─ Containers / air gate-in data
  const overrides = new Map((input.containers ?? []).map((c) => [c.containerNo, c]));
  for (const key of overrides.keys()) {
    if (!shipment.containers.some((c) => c.containerNo === key)) {
      throw new DomainError('UNKNOWN_CONTAINER', `Container ${key} is not on this shipment.`, 422);
    }
  }
  const containerView: (typeof shipment.containers)[number][] = [];
  for (const c of shipment.containers) {
    const o = overrides.get(c.containerNo);
    const stacking: YardStackingType =
      o?.stackingType ?? (c.containerType.startsWith('REEFER') ? 'REEFER_PLUGGED' : c.yardStackingType);
    const freeTimeStartAt = c.freeTimeStartAt ?? arrivedAt;
    await tx.container.update({
      where: { id: c.id },
      data: {
        yardStackingType: stacking,
        yardSlot: o?.yardSlot ?? c.yardSlot,
        gatedInAt: c.gatedInAt ?? arrivedAt,
        stackedAt: arrivedAt,
        freeTimeStartAt,
      },
    });
    containerView.push({ ...c, yardStackingType: stacking, freeTimeStartAt });
  }

  const temperatureC = input.temperatureC;
  if (shipment.airDetail && shipment.requiresColdChain) {
    await tx.airShipmentDetail.update({
      where: { shipmentId: shipment.id },
      data: { coldChainGateInAt: arrivedAt, ...(temperatureC !== undefined ? { gateInTempC: temperatureC } : {}) },
    });
    if (temperatureC === undefined) warnings.push('Cold-chain gate-in recorded without a temperature reading.');
  }
  if (temperatureC !== undefined) {
    const excursion = isExcursion(temperatureC, shipment.airDetail, containerView);
    await tx.temperatureReading.create({
      data: { shipmentId: shipment.id, tempC: temperatureC, isExcursion: excursion, recordedAt: arrivedAt },
    });
    if (excursion) warnings.push(`Gate-in temperature ${temperatureC}°C is outside the configured range — raise an excursion review.`);
  }

  const arrivalMilestone = resolveArrivalMilestone(shipment.mode, shipment.direction, shipment.requiresColdChain, containerView);
  const locationText =
    input.locationText ??
    ([shipment.seaDetail?.terminalName ?? arrivalPort.name, ...containerView.map((c) => c.yardSlot).filter(Boolean).slice(0, 3)]
      .filter(Boolean)
      .join(' · ') || null);

  // 3 ─ Landed cost
  const jurisdiction = shipment.direction === 'IMPORT' ? 'IN' : shipment.pod.countryCode;
  const hsIds = [...new Set(shipment.items.map((i) => i.hsCodeId))];
  const rateRows = await tx.hsDutyRate.findMany({
    where: {
      hsCodeId: { in: hsIds },
      countryCode: jurisdiction,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const dutyByHs = new Map<number, DutyRates>();
  for (const r of rateRows) {
    if (!dutyByHs.has(r.hsCodeId)) {
      dutyByHs.set(r.hsCodeId, {
        bcdRate: r.bcdRate,
        swsRate: r.swsRate,
        additionalDutyRate: r.additionalDutyRate,
        igstRate: r.igstRate,
      });
    }
  }

  const charges: CalcChargeInput[] = [];
  for (const c of shipment.charges) {
    if (COMPUTED_COMPONENTS.has(c.component)) {
      warnings.push(`Posted ${c.component} charge #${c.id} ignored — that component is computed by the duty engine.`);
      continue;
    }
    charges.push({
      component: c.component,
      amount: c.amount,
      currency: c.currencyCode,
      basis: c.allocationBasis,
      isEstimated: c.isEstimated,
      description: c.description ?? undefined,
    });
  }
  // Accrue demurrage per container unless an actual demurrage charge was already posted for it.
  for (const c of containerView) {
    const posted = shipment.charges.some((x) => x.component === 'DEMURRAGE' && x.containerId === c.id);
    if (posted || !c.freeTimeStartAt || !c.demurrageRatePerDay) continue;
    const days = accruedDemurrageDays(c.freeTimeStartAt, asOf, c.freeDays);
    if (days > 0) {
      charges.push({
        component: 'DEMURRAGE',
        amount: c.demurrageRatePerDay.times(days),
        currency: 'INR',
        basis: 'VALUE',
        isEstimated: true,
        description: `Container ${c.containerNo}: ${days} day(s) beyond ${c.freeDays} free`,
      });
    }
  }

  const currencies = [shipment.invoiceCurrencyCode, ...charges.map((c) => c.currency)];
  const { lookup: fx, warnings: fxWarnings } = await buildFx(tx, currencies, asOf);
  warnings.push(...fxWarnings);

  const valuation = VALUATION_POLICY[jurisdiction] ?? DEFAULT_VALUATION;
  const items: CalcItemInput[] = shipment.items.map((i) => ({
    shipmentItemId: i.id,
    hsCode: i.hsCode.code,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    unitCostInr: i.unitCostInr,
    netWeightKg: i.netWeightKg,
    duty: dutyByHs.get(i.hsCodeId) ?? null,
  }));

  const calc = calculateLandedCost({
    items,
    charges,
    invoiceCurrency: shipment.invoiceCurrencyCode,
    fx,
    policy: {
      jurisdiction,
      incoterm: shipment.incoterm,
      igstRecoverable: input.igstRecoverable ?? true,
      landingChargePct: D(valuation.landingChargePct),
      defaultInsurancePctOfFob: valuation.defaultInsurancePctOfFob ? D(valuation.defaultInsurancePctOfFob) : null,
    },
  });
  warnings.push(...calc.warnings);

  await tx.landedCostSheet.updateMany({
    where: { shipmentId: shipment.id, status: { not: 'SUPERSEDED' } },
    data: { status: 'SUPERSEDED' },
  });
  const last = await tx.landedCostSheet.aggregate({ where: { shipmentId: shipment.id }, _max: { versionNo: true } });
  const sheet = await tx.landedCostSheet.create({
    data: {
      shipmentId: shipment.id,
      versionNo: (last._max.versionNo ?? 0) + 1,
      status: calc.hasEstimates ? 'PROVISIONAL' : 'FINAL',
      totalInr: calc.totalInr,
      recoverableTaxInr: calc.recoverableTaxInr,
      hasEstimates: calc.hasEstimates,
      notes: calc.warnings.join(' | ').slice(0, 500) || null,
      computedById: actorId,
    },
  });
  await tx.landedCostLine.createMany({
    data: calc.lines.map((l) => ({
      sheetId: sheet.id,
      shipmentItemId: l.shipmentItemId,
      component: l.component,
      description: l.description,
      originalAmount: l.originalAmount,
      currencyCode: l.currency,
      fxRate: l.fxRate,
      amountInr: l.amountInr,
      isRecoverable: l.isRecoverable,
      isEstimated: l.isEstimated,
    })),
  });
  await tx.landedCostItem.createMany({
    data: calc.items.map((i) => ({
      sheetId: sheet.id,
      shipmentItemId: i.shipmentItemId,
      quantity: i.quantity,
      totalInr: i.totalInr,
      landedUnitCostInr: i.landedUnitCostInr,
    })),
  });

  // 4 ─ Regulatory triggers (FSSAI / BIS / CDSCO / quarantine …)
  const rules = await tx.hsRegulatoryRule.findMany({
    where: { isActive: true, scope: { in: [shipment.direction, 'BOTH'] } },
  });
  const hits = new Map<ClearanceBoard, { ruleId: number; prefixLen: number; hsCodeId: number; hsCodes: Set<string>; leadTimeDays: number | null }>();
  for (const item of shipment.items) {
    for (const rule of rules) {
      if (!item.hsCode.code.startsWith(rule.hsPrefix)) continue;
      if (!rule.isMandatory) {
        warnings.push(`Advisory: ${rule.board} guidance applies to HS ${item.hsCode.code}${rule.description ? ` — ${rule.description}` : ''}.`);
        continue;
      }
      const hit = hits.get(rule.board);
      if (!hit) {
        hits.set(rule.board, {
          ruleId: rule.id,
          prefixLen: rule.hsPrefix.length,
          hsCodeId: item.hsCodeId,
          hsCodes: new Set([item.hsCode.code]),
          leadTimeDays: rule.leadTimeDays,
        });
      } else {
        hit.hsCodes.add(item.hsCode.code);
        if (rule.hsPrefix.length > hit.prefixLen) {
          hit.ruleId = rule.id; // most specific rule wins
          hit.prefixLen = rule.hsPrefix.length;
          hit.leadTimeDays = rule.leadTimeDays;
        }
      }
    }
  }

  const existingByBoard = new Map(shipment.clearances.map((c) => [c.board, c]));
  const compliance: PortArrivalResult['compliance'] = [];
  for (const [board, hit] of hits) {
    const existing = existingByBoard.get(board);
    let status: ClearanceStatus;
    let newlyTriggered = false;
    if (existing) {
      status = existing.status;
    } else {
      const created = await tx.regulatoryClearance.create({
        data: { shipmentId: shipment.id, board, status: 'REQUIRED', ruleId: hit.ruleId, hsCodeId: hit.hsCodeId },
      });
      await tx.complianceEvent.create({
        data: {
          shipmentId: shipment.id,
          clearanceId: created.id,
          board,
          type: 'REQUIREMENT_TRIGGERED',
          message: `${board} clearance required before Out-of-Charge (HS ${[...hit.hsCodes].join(', ')}).`,
          payload: { ruleId: hit.ruleId, hsCodes: [...hit.hsCodes], leadTimeDays: hit.leadTimeDays },
          actorId,
        },
      });
      status = 'REQUIRED';
      newlyTriggered = true;
    }
    compliance.push({ board, status, newlyTriggered, blocking: !['APPROVED', 'NOT_REQUIRED'].includes(status) });
  }
  const blockingBoards = compliance.filter((c) => c.blocking).map((c) => c.board);
  const pgaClearance = compliance.length === 0 ? 'NOT_REQUIRED' : blockingBoards.length > 0 ? 'PENDING' : 'APPROVED';

  // 5 ─ Customs hold
  const holdAt = new Date(Math.max(asOf.getTime(), arrivedAt.getTime()));
  const holdReason = blockingBoards.length > 0 ? 'PGA_PENDING' : 'ASSESSMENT_PENDING';
  const holdNote =
    blockingBoards.length > 0 ? `Awaiting ${blockingBoards.join(', ')} clearance` : 'Awaiting customs assessment / Out-of-Charge';
  const hold = await tx.customsHold.create({
    data: { shipmentId: shipment.id, reason: holdReason, note: holdNote, placedById: actorId, placedAt: holdAt },
  });

  // 6 ─ Tracking: shipment-level + one event per batch, then refresh denormalised position
  const seeds: { milestone: TrackingMilestone; at: Date; remarks?: string }[] = [
    { milestone: arrivalMilestone, at: arrivedAt },
    { milestone: 'CUSTOMS_HOLD_PLACED', at: holdAt, remarks: holdNote },
  ];
  if (blockingBoards.length > 0) {
    seeds.push({
      milestone: 'PGA_CLEARANCE_PENDING',
      at: new Date(holdAt.getTime() + 1),
      remarks: `Pending: ${blockingBoards.join(', ')}`,
    });
  }
  // One event per BATCH (a batch shipped as several graded child lots must not be logged twice).
  const batchRefs = new Map<number, number | null>();
  for (const it of shipment.items) if (!batchRefs.has(it.batchId)) batchRefs.set(it.batchId, it.containerId);

  const events: Prisma.ShipmentTrackingEventCreateManyInput[] = [];
  seeds.forEach((s, idx) => {
    const common = {
      shipmentId: shipment.id,
      locationId: arrivalLocationId,
      actorId,
      milestone: s.milestone,
      locationText,
      temperatureC: idx === 0 ? temperatureC : undefined,
      source: 'SYSTEM' as const,
      occurredAt: s.at,
      remarks: s.remarks,
    };
    events.push(common);
    for (const [batchId, containerId] of batchRefs) events.push({ ...common, batchId, containerId });
  });
  await tx.shipmentTrackingEvent.createMany({ data: events });

  const finalSeed = seeds[seeds.length - 1];
  await tx.shipment.update({
    where: { id: shipment.id },
    data: {
      currentMilestone: finalSeed.milestone,
      currentMilestoneAt: finalSeed.at,
      currentLocationText: locationText,
      pgaClearance,
      ...(shipment.direction === 'IMPORT' ? { ata: arrivedAt } : {}),
    },
  });
  await tx.batch.updateMany({
    where: { id: { in: [...batchRefs.keys()] } },
    data: { currentMilestone: finalSeed.milestone, currentMilestoneAt: finalSeed.at, currentLocationText: locationText },
  });

  // Checklist tracking: Stage 4 port handling (export) / Stage 5 PGA routing (import).
  // Only ever moves a step to IN_PROGRESS here — DONE needs the step's own completion event.
  if (shipment.direction === 'EXPORT') {
    await recordStep(tx, { shipmentId: shipment.id }, 'PORT_TERMINAL_HANDLING_LOADING', 'IN_PROGRESS', { actorId });
  } else if (blockingBoards.length > 0) {
    await recordStep(tx, { shipmentId: shipment.id }, 'PGA_CLEARANCES', 'IN_PROGRESS', {
      actorId,
      note: `Pending: ${blockingBoards.join(', ')}`,
    });
  }

  // 7 ─ Immutable trails
  await tx.shipmentStatusHistory.create({
    data: {
      shipmentId: shipment.id,
      fromStatus: shipment.status,
      toStatus: holdStatus,
      reason: 'Port arrival processed',
      actorId,
      meta: { landedCostSheetId: sheet.id, customsHoldId: hold.id, boardsRequired: compliance.map((c) => c.board) },
    },
  });
  await tx.auditLog.create({
    data: {
      entity: 'Shipment',
      entityId: String(shipment.id),
      action: 'STATUS_CHANGE',
      actorId,
      before: { status: shipment.status, version: shipment.version },
      after: { status: holdStatus, version: shipment.version + 1, landedCostSheetId: sheet.id },
    },
  });

  return {
    alreadyProcessed: false,
    shipmentId: shipment.id,
    status: holdStatus,
    milestone: finalSeed.milestone,
    landedCost: {
      sheetId: sheet.id,
      versionNo: sheet.versionNo,
      status: sheet.status,
      totalInr: calc.totalInr.toFixed(2),
      recoverableTaxInr: calc.recoverableTaxInr.toFixed(2),
      items: calc.items.map((i) => ({
        shipmentItemId: i.shipmentItemId,
        quantity: i.quantity.toString(),
        totalInr: i.totalInr.toFixed(2),
        landedUnitCostInr: i.landedUnitCostInr.toFixed(4),
      })),
    },
    hold: { id: hold.id, reason: holdReason },
    compliance,
    warnings: [...new Set(warnings)],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveArrivalMilestone(
  mode: 'SEA' | 'AIR',
  direction: 'EXPORT' | 'IMPORT',
  coldChain: boolean,
  containers: { yardStackingType: YardStackingType; containerType: string }[],
): TrackingMilestone {
  if (mode === 'AIR') return coldChain ? 'COLD_CHAIN_GATE_IN' : 'AIR_CARGO_GATE_IN';
  const hasReefer = containers.some((c) => c.yardStackingType === 'REEFER_PLUGGED' || c.containerType.startsWith('REEFER'));
  if (hasReefer) return 'PORT_STOCKED_REEFER';
  return direction === 'IMPORT' ? 'DISCHARGED_SEA_YARD' : 'PORT_YARD_STACKED';
}

function isExcursion(
  tempC: number,
  air: { setPointMinC: Decimal | null; setPointMaxC: Decimal | null } | null,
  containers: { containerType: string; reeferSetPointC: Decimal | null }[],
): boolean {
  if (air?.setPointMinC && air.setPointMaxC) {
    return D(tempC).lt(air.setPointMinC) || D(tempC).gt(air.setPointMaxC);
  }
  const reefer = containers.find((c) => c.containerType.startsWith('REEFER') && c.reeferSetPointC);
  if (reefer?.reeferSetPointC) return D(tempC).minus(reefer.reeferSetPointC).abs().gt(REEFER_TOLERANCE_C);
  return false;
}

/**
 * Pre-fetch INR rates so the calculator can stay synchronous.
 * MARKET prefers RBI/bank rates; CUSTOMS prefers the customs-notified rate. Within FX_FRESHNESS_DAYS
 * the preferred source wins; otherwise the most recent row of any source is used (with a warning).
 */
async function buildFx(tx: Tx, currencies: string[], asOf: Date): Promise<{ lookup: FxLookup; warnings: string[] }> {
  const warnings: string[] = [];
  const wanted = [...new Set(currencies)].filter((c) => c !== 'INR');
  const rows = wanted.length
    ? await tx.exchangeRate.findMany({
        where: { fromCurrency: { in: wanted }, toCurrency: 'INR', effectiveDate: { lte: asOf } },
        orderBy: { effectiveDate: 'desc' },
      })
    : [];

  const PREFERENCE: Record<FxKind, string[]> = {
    MARKET: ['RBI_REFERENCE', 'BANK', 'MANUAL', 'CUSTOMS_NOTIFIED'],
    CUSTOMS: ['CUSTOMS_NOTIFIED', 'RBI_REFERENCE', 'BANK', 'MANUAL'],
  };
  const cutoff = asOf.getTime() - FX_FRESHNESS_DAYS * 86_400_000;
  const resolved = new Map<string, Decimal>();

  for (const ccy of wanted) {
    const mine = rows.filter((r) => r.fromCurrency === ccy);
    if (mine.length === 0) {
      throw new DomainError('FX_RATE_MISSING', `No ${ccy}→INR exchange rate on file on or before ${asOf.toISOString().slice(0, 10)}.`, 422, { currency: ccy });
    }
    for (const kind of ['MARKET', 'CUSTOMS'] as FxKind[]) {
      const fresh = mine.filter((r) => r.effectiveDate.getTime() >= cutoff);
      const pool = fresh.length ? fresh : mine;
      if (!fresh.length) warnings.push(`${ccy}→INR rate is older than ${FX_FRESHNESS_DAYS} days; refresh exchange rates.`);
      const pick = PREFERENCE[kind].map((src) => pool.find((r) => r.source === src)).find(Boolean) ?? pool[0];
      resolved.set(`${ccy}:${kind}`, pick.rate);
    }
  }

  const lookup: FxLookup = (currency, kind) => {
    if (currency === 'INR') return D(1);
    const r = resolved.get(`${currency}:${kind}`);
    if (!r) throw new DomainError('FX_RATE_MISSING', `No ${currency}→INR rate resolved.`, 422, { currency });
    return r;
  };
  return { lookup, warnings: [...new Set(warnings)] };
}

/** Read-only result for an already-processed shipment (idempotent replay). */
async function loadExisting(
  tx: Tx,
  shipmentId: number,
  status: PortArrivalResult['status'],
  milestone: TrackingMilestone | null,
): Promise<PortArrivalResult> {
  const [sheet, hold, clearances] = await Promise.all([
    tx.landedCostSheet.findFirst({
      where: { shipmentId, status: { not: 'SUPERSEDED' } },
      orderBy: { versionNo: 'desc' },
      include: { items: true },
    }),
    tx.customsHold.findFirst({ where: { shipmentId, status: 'ACTIVE' }, orderBy: { placedAt: 'desc' } }),
    tx.regulatoryClearance.findMany({ where: { shipmentId } }),
  ]);
  return {
    alreadyProcessed: true,
    shipmentId,
    status,
    milestone,
    landedCost: sheet && {
      sheetId: sheet.id,
      versionNo: sheet.versionNo,
      status: sheet.status,
      totalInr: sheet.totalInr.toFixed(2),
      recoverableTaxInr: sheet.recoverableTaxInr.toFixed(2),
      items: sheet.items.map((i) => ({
        shipmentItemId: i.shipmentItemId,
        quantity: i.quantity.toString(),
        totalInr: i.totalInr.toFixed(2),
        landedUnitCostInr: i.landedUnitCostInr.toFixed(4),
      })),
    },
    hold: hold && { id: hold.id, reason: hold.reason },
    compliance: clearances.map((c) => ({
      board: c.board,
      status: c.status,
      newlyTriggered: false,
      blocking: !['APPROVED', 'NOT_REQUIRED'].includes(c.status),
    })),
    warnings: [],
  };
}
