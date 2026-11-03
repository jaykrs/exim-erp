import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Shipments() {
  const rows = await prisma.shipment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { buyer: { select: { name: true } }, pol: { select: { unlocode: true } }, pod: { select: { unlocode: true } } },
  });
  return (
    <Page title="Shipments" sub="Most recent 100.">
      <Table
        head={['Shipment', 'Dir', 'Mode', 'Route', 'Party', 'Status', 'Milestone', 'ETA', 'Value']}
        rows={rows.map((s) => [
          <Link key="l" href={`/shipments/${s.id}`}>{s.shipmentNo}</Link>, s.direction, s.mode, `${s.pol.unlocode} → ${s.pod.unlocode}`, s.buyer.name,
          <Pill key="s" value={s.status} />, <Pill key="m" value={s.currentMilestone} />, fmtDate(s.eta), `${s.invoiceCurrencyCode} ${money(s.declaredValue)}`,
        ])}
      />
    </Page>
  );
}
