import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Page, Pill, Table, fmtDate, fmtDateTime, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Finance() {
  const [sheets, lcs, ledger] = await Promise.all([
    prisma.landedCostSheet.findMany({ orderBy: { computedAt: 'desc' }, take: 50, include: { shipment: { select: { id: true, shipmentNo: true } } } }),
    prisma.letterOfCredit.findMany({ orderBy: { expiryDate: 'asc' }, take: 50 }),
    prisma.financeLedgerEntry.findMany({ orderBy: { postedAt: 'desc' }, take: 50 }),
  ]);
  return (
    <Page title="Finance" sub="Landed-cost sheets, letters of credit and the ledger (steps 20, 23).">
      <h3>Landed-cost sheets</h3>
      <Table head={['Shipment', 'Version', 'Status', 'Total (INR)', 'Recoverable tax (INR)', 'Has estimates', 'Computed']}
        rows={sheets.map((s) => [<Link key="l" href={`/shipments/${s.shipment.id}`}>{s.shipment.shipmentNo}</Link>, `v${s.versionNo}`, <Pill key="s" value={s.status} />, money(s.totalInr), money(s.recoverableTaxInr), s.hasEstimates ? 'yes' : 'no', fmtDateTime(s.computedAt)])} />
      <h3>Letters of credit</h3>
      <Table head={['LC', 'Type', 'Status', 'Amount', 'Expiry']}
        rows={lcs.map((l) => [l.lcNo, l.type, <Pill key="s" value={l.status} />, `${l.currencyCode} ${money(l.amount)}`, fmtDate(l.expiryDate)])} />
      <h3>Ledger (append-only)</h3>
      <Table head={['Posted', 'Type', 'Reference', 'Amount', 'INR']}
        rows={ledger.map((e) => [fmtDateTime(e.postedAt), e.entryType.replaceAll('_', ' '), e.reference ?? '—', `${e.currencyCode} ${money(e.amount)}`, money(e.amountInr)])} />
    </Page>
  );
}
