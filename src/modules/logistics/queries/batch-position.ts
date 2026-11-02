import { DomainError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';

/**
 * "Where is batch X right now?" — O(1) read of the denormalised columns on Batch, plus the
 * indexed (batchId, occurredAt) trail for the full history. Both are kept in sync by services
 * (e.g. processPortArrival) inside the same transaction that appends the tracking event.
 */
export async function getBatchPosition(batchNo: string, trailLimit = 50) {
  const batch = await prisma.batch.findUnique({
    where: { batchNo },
    select: {
      id: true,
      batchNo: true,
      currentMilestone: true,
      currentMilestoneAt: true,
      currentLocationText: true,
      shipmentItems: {
        orderBy: { id: 'desc' },
        take: 1,
        select: { shipment: { select: { id: true, shipmentNo: true, mode: true, status: true, eta: true } } },
      },
    },
  });
  if (!batch) throw new DomainError('BATCH_NOT_FOUND', `Batch ${batchNo} not found.`, 404);

  const trail = await prisma.shipmentTrackingEvent.findMany({
    where: { batchId: batch.id },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: trailLimit,
    select: {
      id: true,
      milestone: true,
      occurredAt: true,
      locationText: true,
      temperatureC: true,
      source: true,
      location: { select: { unlocode: true, name: true } },
    },
  });

  return {
    batchNo: batch.batchNo,
    current: {
      milestone: batch.currentMilestone, // e.g. 'PORT_STOCKED_REEFER', 'IN_TRANSIT_TARMAC', 'DISCHARGED_SEA_YARD'
      since: batch.currentMilestoneAt,
      locationText: batch.currentLocationText,
    },
    shipment: batch.shipmentItems[0]?.shipment ?? null,
    trail: trail.map((e) => ({ ...e, id: e.id.toString() })), // BigInt is not JSON-serialisable
  };
}
