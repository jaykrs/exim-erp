/**
 * Stage 6 — last mile (step 21), delivery proof & quality sign-off (step 22).
 * Imports are delivered from CUSTOMS_RELEASED; exports are acknowledged by the buyer from IN_TRANSIT.
 */
import type { ShipmentStatus, TradeDirection } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { runTx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';
import { batchIdsOf, ensureDirectionSteps, loadShipment, recordMilestone, updateShipment } from '@/modules/shared/shipment-ops';

const DELIVERABLE_FROM: Record<TradeDirection, ShipmentStatus[]> = {
  IMPORT: ['CUSTOMS_RELEASED'],
  EXPORT: ['IN_TRANSIT'],
};

export async function startLastMile(input: { shipmentId: number; startedAt: Date; vehicleNo?: string; locationText?: string; actorId?: number }) {
  return runTx(async (tx) => {
    const probe = await loadShipment(tx, input.shipmentId);
    const shipment = await loadShipment(tx, input.shipmentId, { allowedFrom: DELIVERABLE_FROM[probe.direction] });
    await ensureDirectionSteps(tx, shipment.id, shipment.direction);
    await recordMilestone(tx, {
      shipmentId: shipment.id,
      milestone: 'LAST_MILE_DELIVERY',
      at: input.startedAt,
      actorId: input.actorId,
      locationText: input.locationText,
      remarks: input.vehicleNo ? `Vehicle ${input.vehicleNo}` : undefined,
      batches: 'all',
    });
    await recordStep(tx, { shipmentId: shipment.id }, 'LAST_MILE_TRANSPORTATION', 'IN_PROGRESS', { actorId: input.actorId, note: input.vehicleNo });
    return { shipmentId: shipment.id, milestone: 'LAST_MILE_DELIVERY' as const };
  });
}

export async function confirmDelivery(input: {
  shipmentId: number;
  deliveredAt: Date;
  receivedBy: string;
  qualityOk: boolean;
  /** Link to the signed proof of delivery. */
  podUrl: string;
  note?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const probe = await loadShipment(tx, input.shipmentId);
    const shipment = await loadShipment(tx, input.shipmentId, { allowedFrom: DELIVERABLE_FROM[probe.direction] });
    if (!input.receivedBy.trim()) throw new DomainError('RECEIVER_REQUIRED', 'Record who signed for the goods.', 422);
    await ensureDirectionSteps(tx, shipment.id, shipment.direction);

    await recordStep(tx, { shipmentId: shipment.id }, 'LAST_MILE_TRANSPORTATION', 'DONE', { actorId: input.actorId });

    if (!input.qualityOk) {
      await recordMilestone(tx, {
        shipmentId: shipment.id, milestone: 'EXCEPTION_RAISED', at: input.deliveredAt, actorId: input.actorId,
        remarks: input.note ?? 'Quality sign-off failed', batches: 'all',
      });
      await recordStep(tx, { shipmentId: shipment.id }, 'DELIVERY_PROOF_QUALITY_SIGNOFF', 'BLOCKED', {
        actorId: input.actorId, evidenceUrl: input.podUrl, note: input.note, reopen: true,
      });
      return { shipmentId: shipment.id, status: shipment.status, exception: true };
    }

    await updateShipment(
      tx,
      shipment,
      shipment.direction === 'EXPORT' ? { ata: input.deliveredAt } : {},
      { to: 'DELIVERED', actorId: input.actorId, reason: `Delivered; received by ${input.receivedBy}` },
    );
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'POD_SIGNED', at: input.deliveredAt, actorId: input.actorId, batches: 'all', remarks: `Received by ${input.receivedBy}` });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'DELIVERED', at: new Date(input.deliveredAt.getTime() + 1), actorId: input.actorId, batches: 'all' });

    const batchIds = await batchIdsOf(tx, shipment.id);
    if (batchIds.length > 0) {
      await tx.batch.updateMany({ where: { id: { in: batchIds } }, data: { currentOwner: 'IMPORT_PARTY', status: 'DISPATCHED' } });
    }
    await recordStep(tx, { shipmentId: shipment.id }, 'DELIVERY_PROOF_QUALITY_SIGNOFF', 'DONE', {
      actorId: input.actorId, evidenceUrl: input.podUrl, note: input.note, reopen: true,
    });
    await writeAudit(tx, { entity: 'Shipment', entityId: shipment.id, action: 'STATUS_CHANGE', actorId: input.actorId, before: { status: shipment.status }, after: { status: 'DELIVERED', ownerTransferredBatches: batchIds.length } });
    return { shipmentId: shipment.id, status: 'DELIVERED' as const, ownershipTransferredBatches: batchIds.length, exception: false };
  });
}
