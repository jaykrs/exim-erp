import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Sourcing() {
  const [vendors, pos] = await Promise.all([
    prisma.vendor.findMany({ orderBy: { code: 'asc' }, take: 200, include: { _count: { select: { batches: true } } } }),
    prisma.purchaseOrder.findMany({ orderBy: { orderDate: 'desc' }, take: 100, include: { vendor: { select: { name: true } } } }),
  ]);
  return (
    <Page title="Sourcing" sub="Vendors and purchase orders (checklist steps 1–4).">
      <h3>Vendors</h3>
      <Table head={['Code', 'Name', 'Country', 'Status', 'Onboarded', 'Batches']}
        rows={vendors.map((v) => [v.code, v.name, v.countryCode, <Pill key="s" value={v.status} />, fmtDate(v.onboardedAt), v._count.batches])} />
      <h3>Purchase orders</h3>
      <Table head={['PO', 'Vendor', 'Incoterm', 'Status', 'Ordered', 'Total']}
        rows={pos.map((p) => [p.poNo, p.vendor.name, p.incoterm, <Pill key="s" value={p.status} />, fmtDate(p.orderDate), `${p.currencyCode} ${money(p.totalAmount)}`])} />
    </Page>
  );
}
