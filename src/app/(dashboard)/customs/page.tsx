import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate, fmtDateTime, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Customs() {
  const [holds, sbs, boes] = await Promise.all([
    prisma.customsHold.findMany({ where: { status: { not: 'RELEASED' } }, orderBy: { placedAt: 'desc' }, take: 100, include: { shipment: { select: { id: true, shipmentNo: true } } } }),
    prisma.shippingBill.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { shipment: { select: { id: true, shipmentNo: true } } } }),
    prisma.billOfEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { shipment: { select: { id: true, shipmentNo: true } } } }),
  ]);
  const link = (s: { id: number; shipmentNo: string }) => <Link key={s.id} href={`/shipments/${s.id}`}>{s.shipmentNo}</Link>;
  return (
    <Page title="Customs" sub="Holds, shipping bills and bills of entry (steps 11–17, 19).">
      <h3>Active holds</h3>
      <Table head={['Shipment', 'Reason', 'Status', 'Placed']} empty="No active holds."
        rows={holds.map((h) => [link(h.shipment), h.reason.replaceAll('_', ' '), <Pill key="s" value={h.status} />, fmtDateTime(h.placedAt)])} />
      <h3>Shipping bills (export)</h3>
      <Table head={['Shipment', 'SB no', 'Date', 'Status', 'IGST mode', 'FOB (INR)', 'LEO']}
        rows={sbs.map((b) => [link(b.shipment), b.sbNo ?? '—', fmtDate(b.sbDate), <Pill key="s" value={b.status} />, b.igstMode.replaceAll('_', ' '), money(b.fobValueInr), b.leoNo ?? '—'])} />
      <h3>Bills of entry (import)</h3>
      <Table head={['Shipment', 'BoE no', 'Date', 'Status', 'Assessable (INR)', 'Duty (INR)', 'OOC']}
        rows={boes.map((b) => [link(b.shipment), b.boeNo ?? '—', fmtDate(b.boeDate), <Pill key="s" value={b.status} />, money(b.assessableValueInr), money(b.totalDutyInr), b.oocNo ?? '—'])} />
    </Page>
  );
}
