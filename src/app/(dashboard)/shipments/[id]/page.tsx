import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getConsignmentTimeline } from '@/modules/consignment/step-tracker';
import { DomainError } from '@/lib/errors';
import { Cards, Page, Pill, Table, fmtDateTime, money } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ShipmentDetail({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  const timeline = await getConsignmentTimeline(id).catch((e) => {
    if (e instanceof DomainError && e.httpStatus === 404) return null;
    throw e;
  });
  if (!timeline) notFound();

  const [events, holds, clearances, sheet] = await Promise.all([
    prisma.shipmentTrackingEvent.findMany({ where: { shipmentId: id }, orderBy: { occurredAt: 'desc' }, take: 50 }),
    prisma.customsHold.findMany({ where: { shipmentId: id }, orderBy: { placedAt: 'desc' } }),
    prisma.regulatoryClearance.findMany({ where: { shipmentId: id }, orderBy: { id: 'asc' } }),
    prisma.landedCostSheet.findFirst({ where: { shipmentId: id }, orderBy: { versionNo: 'desc' }, include: { lines: true } }),
  ]);
  const { shipment, overall } = timeline;

  return (
    <Page title={shipment.shipmentNo} sub={`${shipment.direction} · ${shipment.locationText ?? 'location not reported'}`}>
      <Cards items={[
        ['Status', <Pill key="s" value={shipment.status} />],
        ['Milestone', <Pill key="m" value={shipment.currentMilestone} />],
        ['Checklist', `${overall.done} / ${overall.total}`],
        ['Landed cost (INR)', sheet ? money(sheet.totalInr) : '—'],
      ]} />

      <h3>Consignment checklist</h3>
      {timeline.stages.map((st) => (
        <div className="card stage" key={st.stage}>
          <b style={{ fontSize: 14 }}>{st.title}</b>
          {st.steps.map((s) => (
            <div className="step" key={s.code}>
              <span className="t">{s.title}{s.scope !== 'SHIPMENT' ? ` (${s.progress.done}/${s.progress.total} ${s.scope.toLowerCase().replace('_', ' ')}s)` : ''}</span>
              <Pill value={s.applicable ? s.status : 'N/A'} />
            </div>
          ))}
        </div>
      ))}

      <h3>Tracking events</h3>
      <Table head={['When (UTC)', 'Milestone', 'Location', 'Temp °C', 'Source']}
        rows={events.map((e) => [fmtDateTime(e.occurredAt), <Pill key="p" value={e.milestone} />, e.locationText ?? '—', e.temperatureC?.toString() ?? '—', e.source])} />

      <h3>Customs holds</h3>
      <Table head={['Reason', 'Status', 'Placed', 'Released']} empty="No holds."
        rows={holds.map((h) => [h.reason.replaceAll('_', ' '), <Pill key="s" value={h.status} />, fmtDateTime(h.placedAt), fmtDateTime(h.releasedAt)])} />

      <h3>Regulatory clearances</h3>
      <Table head={['Board', 'Status', 'Application', 'Reference', 'Valid till']} empty="No clearances required."
        rows={clearances.map((c) => [c.board, <Pill key="s" value={c.status} />, c.applicationNo ?? '—', c.referenceNo ?? '—', c.validTill ? c.validTill.toISOString().slice(0, 10) : '—'])} />

      <h3>Landed cost{sheet ? ` — v${sheet.versionNo} (${sheet.status})` : ''}</h3>
      <Table head={['Component', 'Amount (INR)', 'Estimated']} empty="Not computed yet — runs at port arrival."
        rows={(sheet?.lines ?? []).map((l) => [String(l.component).replaceAll('_', ' '), money(l.amountInr), l.isEstimated ? 'yes' : 'no'])} />
    </Page>
  );
}
