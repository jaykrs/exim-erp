import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Compliance() {
  const [open, tests] = await Promise.all([
    prisma.regulatoryClearance.findMany({
      where: { status: { notIn: ['APPROVED', 'WAIVED'] } },
      orderBy: { requiredBy: 'asc' },
      take: 200,
      include: { shipment: { select: { id: true, shipmentNo: true } } },
    }),
    prisma.batch.findMany({ where: { complianceStatus: { not: 'PASSED' } }, take: 100, select: { id: true, batchNo: true, complianceStatus: true, status: true } }),
  ]);
  return (
    <Page title="Compliance" sub="Open regulatory clearances and batches awaiting validation (steps 8–10, 18).">
      <h3>Open clearances</h3>
      <Table head={['Shipment', 'Board', 'Status', 'Application', 'Required by']} empty="No open clearances."
        rows={open.map((c) => [<Link key="l" href={`/shipments/${c.shipment.id}`}>{c.shipment.shipmentNo}</Link>, c.board, <Pill key="s" value={c.status} />, c.applicationNo ?? '—', fmtDate(c.requiredBy)])} />
      <h3>Batches not yet compliant</h3>
      <Table head={['Batch', 'Compliance', 'Status']} empty="All batches compliant."
        rows={tests.map((b) => [b.batchNo, <Pill key="c" value={b.complianceStatus} />, <Pill key="s" value={b.status} />])} />
    </Page>
  );
}
