import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Cards, Page, Pill, Table, fmtDateTime } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const [active, holds, pendingClear, onHold, recent] = await Promise.all([
    prisma.shipment.count({ where: { status: { notIn: ['DELIVERED', 'CLOSED', 'CANCELLED'] } } }),
    prisma.customsHold.count({ where: { status: 'ACTIVE' } }),
    prisma.regulatoryClearance.count({ where: { status: { notIn: ['APPROVED', 'WAIVED'] } } }),
    prisma.batch.count({ where: { status: 'ON_HOLD' } }),
    prisma.shipmentTrackingEvent.findMany({ orderBy: { occurredAt: 'desc' }, take: 10, include: { shipment: { select: { id: true, shipmentNo: true } } } }),
  ]);
  return (
    <Page title="Overview" sub="Live position across sourcing, warehouse, customs and finance.">
      <Cards items={[['Active shipments', active], ['Active customs holds', holds], ['Open clearances', pendingClear], ['Batches on hold', onHold]]} />
      <h3>Latest tracking events</h3>
      <Table
        head={['When (UTC)', 'Shipment', 'Milestone', 'Location']}
        rows={recent.map((e) => [fmtDateTime(e.occurredAt), <Link key="l" href={`/shipments/${e.shipment.id}`}>{e.shipment.shipmentNo}</Link>, <Pill key="p" value={e.milestone} />, e.locationText ?? '—'])}
      />
    </Page>
  );
}
