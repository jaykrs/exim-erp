import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Warehouse() {
  const batches = await prisma.batch.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { product: { select: { sku: true, name: true } }, warehouse: { select: { code: true } } },
  });
  return (
    <Page title="Warehouse" sub="Batches, grading and traceability (steps 5–7).">
      <Table head={['Batch', 'Trace code', 'Product', 'Warehouse', 'Qty', 'Available', 'Status', 'Compliance', 'Expires', 'Position']}
        rows={batches.map((b) => [b.batchNo, b.traceabilityCode ?? '—', `${b.product.sku} · ${b.product.name}`, b.warehouse.code,
          money(b.quantity), money(b.availableQty), <Pill key="s" value={b.status} />, <Pill key="c" value={b.complianceStatus} />, fmtDate(b.expiresOn), <Pill key="m" value={b.currentMilestone} />])} />
    </Page>
  );
}
