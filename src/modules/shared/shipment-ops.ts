/**
 * Shared building blocks for the checklist services: guarded shipment status moves (optimistic lock +
 * history), milestone/tracking writes (append event + refresh denormalised position), and direction-aware
 * checklist skipping. Everything takes the caller's transaction.
 */
import type { ShipmentStatus, TrackingMilestone, TradeDirection, TransportMode } from '@prisma/client';
import { DomainError } from '@/lib/errors';
import type { Tx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';
import type { WorkflowStepCode } from '@/modules/consignment/workflow';

export interface ShipmentCore {
  id: number;
  direction: TradeDirection;
  mode: TransportMode;
  status: ShipmentStatus;
  version: number;
}

/** Steps that do not apply to a shipment because of its direction (tracked elsewhere in the journey). */
const SKIPPED_FOR: Record<TradeDirection, WorkflowStepCode[]> = {
  EXPORT: [
    'PRE_ARRIVAL_MANIFEST_FILING',
    'BILL_OF_ENTRY_SUBMISSION',
    'PGA_CLEARANCES',
    'DUTY_ASSESSMENT_OOC',
    'LANDED_COST_CONSOLIDATION',
  ],
  IMPORT: [
    'SHIPPING_BILL_FILING',
    'ZERO_RATED_INCENTIVE_LOGGING',
    'CUSTOMS_EXAMINATION_LEO',
    'PORT_TERMINAL_HANDLING_LOADING',
    'DEPARTURE_CONFIRMATION',
  ],
};

export async function loadShipment(
  tx: Tx,
  shipmentId: number,
  opts: { direction?: TradeDirection; allowedFrom?: ShipmentStatus[] } = {},
): Promise<ShipmentCore> {
  const s = await tx.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, direction: true, mode: true, status: true, version: true },
  });
  if (!s) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${shipmentId} does not exist.`, 404);
  if (opts.direction && s.direction !== opts.direction) {
    throw new DomainError('WRONG_DIRECTION', `This operation applies to ${opts.direction} shipments; ${s.id} is ${s.direction}.`, 409);
  }
  if (opts.allowedFrom && !opts.allowedFrom.includes(s.status)) {
    throw new DomainError('INVALID_STATUS', `Not allowed from status ${s.status}.`, 409, { status: s.status, allowedFrom: opts.allowedFrom });
  }
  return s;
}

/**
 * Update shipment columns under the optimistic lock (id + version + status). 0 rows → 409. Bumps `version`.
 * Pass `to` to also change status and append a ShipmentStatusHistory row.
 */
export async function updateShipment(
  tx: Tx,
  s: ShipmentCore,
  data: Record<string, unknown>,
  opts: { to?: ShipmentStatus; actorId?: number; reason?: string; meta?: unknown } = {},
): Promise<void> {
  const res = await tx.shipment.updateMany({
    where: { id: s.id, version: s.version, status: s.status },
    data: { ...data, ...(opts.to ? { status: opts.to } : {}), version: { increment: 1 } },
  });
  if (res.count !== 1) {
    throw new DomainError('CONCURRENT_UPDATE', 'Shipment was modified by someone else; reload and retry.', 409);
  }
  if (opts.to && opts.to !== s.status) {
    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: s.id,
        fromStatus: s.status,
        toStatus: opts.to,
        reason: opts.reason ?? null,
        actorId: opts.actorId ?? null,
        ...(opts.meta !== undefined ? { meta: JSON.parse(JSON.stringify(opts.meta)) } : {}),
      },
    });
  }
}

export interface MilestoneInput {
  shipmentId: number;
  milestone: TrackingMilestone;
  at: Date;
  actorId?: number;
  locationText?: string;
  /** 'all' = every batch on the shipment; or an explicit list; omitted = shipment-level only. */
  batches?: 'all' | number[];
  remarks?: string;
}

/** Append tracking events (shipment + batches) and refresh the denormalised "current position". */
export async function recordMilestone(tx: Tx, m: MilestoneInput): Promise<{ batchIds: number[] }> {
  let batchIds: number[] = [];
  if (m.batches === 'all') {
    const items = await tx.shipmentItem.findMany({ where: { shipmentId: m.shipmentId }, select: { batchId: true } });
    batchIds = [...new Set(items.map((i) => i.batchId))];
  } else if (Array.isArray(m.batches)) {
    batchIds = [...new Set(m.batches)];
  }

  const base = {
    shipmentId: m.shipmentId,
    milestone: m.milestone,
    locationText: m.locationText ?? null,
    actorId: m.actorId ?? null,
    source: 'API' as const,
    remarks: m.remarks ?? null,
    occurredAt: m.at,
  };
  await tx.shipmentTrackingEvent.createMany({ data: [{ ...base, batchId: null }, ...batchIds.map((batchId) => ({ ...base, batchId }))] });

  const position = { currentMilestone: m.milestone, currentMilestoneAt: m.at, ...(m.locationText ? { currentLocationText: m.locationText } : {}) };
  await tx.shipment.update({ where: { id: m.shipmentId }, data: position });
  if (batchIds.length > 0) await tx.batch.updateMany({ where: { id: { in: batchIds } }, data: position });
  return { batchIds };
}

/** Mark steps that cannot apply to this shipment's direction as SKIPPED (only where no row exists yet). */
export async function ensureDirectionSteps(tx: Tx, shipmentId: number, direction: TradeDirection): Promise<void> {
  for (const code of SKIPPED_FOR[direction]) {
    const existing = await tx.consignmentStep.findFirst({ where: { shipmentId, stepCode: code }, select: { id: true } });
    if (!existing) await recordStep(tx, { shipmentId }, code, 'SKIPPED');
  }
}

/** Distinct batch ids carried by a shipment. */
export async function batchIdsOf(tx: Tx, shipmentId: number): Promise<number[]> {
  const items = await tx.shipmentItem.findMany({ where: { shipmentId }, select: { batchId: true } });
  return [...new Set(items.map((i) => i.batchId))];
}
