/**
 * Stages 4 & 5 — export customs (steps 11–13, 15), loading (14), manifest (16), Bill of Entry (17), OOC (19).
 * Direction matters: export shipments run 11–15, import shipments run 16–20 (the other steps are marked SKIPPED).
 */
import type { IgstPaymentMode, ManifestType } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { D, round2, sum } from '@/lib/money';
import { runTx, type Tx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';
import { ensureDirectionSteps, loadShipment, recordMilestone, updateShipment } from '@/modules/shared/shipment-ops';

const ms = (d: Date, plus = 0) => new Date(d.getTime() + plus);

async function activeBill(tx: Tx, shipmentId: number) {
  const bills = await tx.shippingBill.findMany({ where: { shipmentId }, orderBy: { id: 'desc' } });
  return bills.find((b) => b.status !== 'CANCELLED') ?? null;
}

async function releaseHolds(tx: Tx, shipmentId: number, at: Date): Promise<number> {
  const res = await tx.customsHold.updateMany({
    where: { shipmentId, status: { in: ['ACTIVE', 'ESCALATED'] } },
    data: { status: 'RELEASED', releasedAt: at },
  });
  return res.count;
}

// ── Step 11 — shipping bill filing (export) ─────────────────────────────────
export interface ShippingBillInput {
  shipmentId: number;
  portId: number;
  sbNo: string;
  sbDate: Date;
  igstMode: IgstPaymentMode;
  /** Customs-notified export rate: INR per 1 unit of the invoice currency. */
  exchangeRate: string;
  icegateRefNo?: string;
  items: { shipmentItemId: number; rodtepRatePct?: string; drawbackRatePct?: string; igstRatePct?: string }[];
  actorId?: number;
}

export async function fileShippingBill(input: ShippingBillInput) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'EXPORT' });
    const existing = await activeBill(tx, shipment.id);
    if (existing) {
      if (existing.sbNo === input.sbNo) return { shippingBillId: existing.id, sbNo: existing.sbNo, alreadyFiled: true };
      throw new DomainError('SB_ALREADY_FILED', `Shipment already has shipping bill ${existing.sbNo}.`, 409);
    }
    if (!['PLANNED', 'BOOKED', 'GATED_IN', 'AT_PORT'].includes(shipment.status)) {
      throw new DomainError('INVALID_STATUS', `A shipping bill cannot be filed from status ${shipment.status}.`, 409);
    }
    const rate = D(input.exchangeRate);
    if (rate.lte(0)) throw new DomainError('BAD_FX', 'Exchange rate must be positive.', 422);

    const items = await tx.shipmentItem.findMany({ where: { shipmentId: shipment.id } });
    if (items.length === 0) throw new DomainError('NO_ITEMS', 'Shipment has no items to declare.', 422);
    const declared = new Map(input.items.map((i) => [i.shipmentItemId, i]));
    const missing = items.filter((i) => !declared.has(i.id)).map((i) => i.id);
    const unknown = input.items.filter((i) => !items.some((x) => x.id === i.shipmentItemId)).map((i) => i.shipmentItemId);
    if (missing.length || unknown.length) {
      throw new DomainError('ITEMS_MISMATCH', 'Declare every shipment item exactly once.', 422, { missing, unknown });
    }
    const batchIds = [...new Set(items.map((i) => i.batchId))];
    const batches = await tx.batch.findMany({ where: { id: { in: batchIds } } });
    const notCompliant = batches.filter((b) => b.complianceStatus !== 'PASSED').map((b) => b.batchNo);
    if (notCompliant.length) throw new DomainError('BATCH_NOT_COMPLIANT', 'Every batch needs a passed PSI / lab result before filing.', 422, { batches: notCompliant });

    const rows = items.map((it) => {
      const d = declared.get(it.id)!;
      const fcy = D(it.quantity).mul(D(it.unitPrice));
      const fob = round2(fcy.mul(rate));
      let igst = D(0);
      if (input.igstMode === 'PAID_WITH_REFUND_CLAIM') {
        if (d.igstRatePct === undefined) throw new DomainError('IGST_RATE_REQUIRED', `Item ${it.id}: igstRatePct is required when IGST is paid.`, 422);
        igst = round2(fob.mul(D(d.igstRatePct)).div(100));
      }
      return {
        it,
        fcy,
        fob,
        igst,
        rodtep: round2(fob.mul(D(d.rodtepRatePct ?? 0)).div(100)),
        drawback: round2(fob.mul(D(d.drawbackRatePct ?? 0)).div(100)),
        rodtepRate: D(d.rodtepRatePct ?? 0),
        drawbackRate: D(d.drawbackRatePct ?? 0),
      };
    });

    const now = new Date();
    const bill = await tx.shippingBill.create({
      data: {
        shipmentId: shipment.id,
        portId: input.portId,
        sbNo: input.sbNo,
        sbDate: input.sbDate,
        status: 'FILED',
        igstMode: input.igstMode,
        fobValueInr: sum(rows.map((r) => r.fob)).toFixed(2),
        fobValueFcy: sum(rows.map((r) => r.fcy)).toFixed(2),
        exchangeRate: rate.toFixed(6),
        icegateRefNo: input.icegateRefNo ?? null,
        filedAt: now,
      },
    });
    for (const r of rows) {
      await tx.shippingBillItem.create({
        data: {
          shippingBillId: bill.id,
          shipmentItemId: r.it.id,
          hsCodeId: r.it.hsCodeId,
          quantity: D(r.it.quantity).toFixed(3),
          fobValueInr: r.fob.toFixed(2),
          igstAmount: r.igst.toFixed(2),
          rodtepRate: r.rodtepRate.toFixed(4),
          rodtepAmount: r.rodtep.toFixed(2),
          drawbackRate: r.drawbackRate.toFixed(4),
          drawbackAmount: r.drawback.toFixed(2),
        },
      });
    }
    await tx.icegateMessage.create({
      data: { shipmentId: shipment.id, messageType: 'SB_FILING', direction: 'OUTBOUND', referenceNo: input.sbNo, request: { sbNo: input.sbNo, items: rows.length } },
    });
    await updateShipment(tx, shipment, { shippingBillNo: input.sbNo }, { to: 'CUSTOMS_EXPORT_PROCESSING', actorId: input.actorId, reason: `Shipping bill ${input.sbNo} filed` });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'SHIPPING_BILL_FILED', at: now, actorId: input.actorId, batches: 'all' });
    await ensureDirectionSteps(tx, shipment.id, 'EXPORT');
    await recordStep(tx, { shipmentId: shipment.id }, 'SHIPPING_BILL_FILING', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'ShippingBill', entityId: bill.id, action: 'CREATE', actorId: input.actorId, after: { sbNo: input.sbNo, fobValueInr: String(bill.fobValueInr) } });
    return { shippingBillId: bill.id, sbNo: input.sbNo, fobValueInr: sum(rows.map((r) => r.fob)).toFixed(2), alreadyFiled: false };
  });
}

// ── Step 12 — zero-rated invoice + incentive logging (export) ───────────────
export async function logZeroRatedAndIncentives(input: {
  shipmentId: number;
  invoiceNo: string;
  invoiceDate: Date;
  dueDate?: Date;
  paymentTerms?: string;
  freight?: string;
  insurance?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await tx.shipment.findUnique({ where: { id: input.shipmentId } });
    if (!shipment) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${input.shipmentId} does not exist.`, 404);
    if (shipment.direction !== 'EXPORT') throw new DomainError('WRONG_DIRECTION', 'Incentive logging applies to export shipments.', 409);

    const already = await tx.invoice.findFirst({ where: { shipmentId: shipment.id, type: 'COMMERCIAL' } });
    if (already) return { invoiceId: already.id, alreadyLogged: true };

    const bill = await activeBill(tx, shipment.id);
    if (!bill) throw new DomainError('NO_SHIPPING_BILL', 'File the shipping bill first.', 409);
    const billItems = await tx.shippingBillItem.findMany({ where: { shippingBillId: bill.id } });

    let lutId: number | null = null;
    if (bill.igstMode === 'LUT_ZERO_RATED') {
      const luts = await tx.lutRegistration.findMany({ where: { companyId: shipment.companyId, status: 'ACTIVE' } });
      const lut = luts.find((l) => l.validFrom <= input.invoiceDate && l.validTill >= input.invoiceDate);
      if (!lut) throw new DomainError('NO_ACTIVE_LUT', 'Zero-rated supply needs a valid LUT covering the invoice date.', 422);
      lutId = lut.id;
    }

    const shipItems = await tx.shipmentItem.findMany({ where: { shipmentId: shipment.id } });
    const products = await tx.product.findMany({ where: { id: { in: [...new Set(shipItems.map((i) => i.productId))] } } });
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const rate = D(bill.exchangeRate ?? 0);

    const lines = shipItems.map((it) => {
      const bi = billItems.find((b) => b.shipmentItemId === it.id);
      const amount = round2(D(it.quantity).mul(D(it.unitPrice)));
      const fob = bi ? D(bi.fobValueInr) : D(0);
      const igst = bi ? D(bi.igstAmount) : D(0);
      return { it, amount, igst, igstRate: fob.gt(0) ? igst.div(fob).mul(100) : D(0) };
    });
    const subtotal = sum(lines.map((l) => l.amount));
    const freight = D(input.freight ?? 0);
    const insurance = D(input.insurance ?? 0);

    const invoice = await tx.invoice.create({
      data: {
        invoiceNo: input.invoiceNo,
        companyId: shipment.companyId,
        shipmentId: shipment.id,
        lutId,
        type: 'COMMERCIAL',
        status: 'ISSUED',
        currencyCode: shipment.invoiceCurrencyCode,
        exchangeRate: rate.toFixed(6),
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        subtotal: subtotal.toFixed(2),
        freight: freight.toFixed(2),
        insurance: insurance.toFixed(2),
        totalAmount: subtotal.plus(freight).plus(insurance).toFixed(2),
        taxableValueInr: D(bill.fobValueInr ?? 0).toFixed(2),
        igstMode: bill.igstMode,
        igstAmountInr: sum(lines.map((l) => l.igst)).toFixed(2),
        paymentTerms: input.paymentTerms ?? null,
      },
    });
    for (const l of lines) {
      await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          shipmentItemId: l.it.id,
          hsCodeId: l.it.hsCodeId,
          description: nameOf.get(l.it.productId) ?? `Item ${l.it.id}`,
          quantity: D(l.it.quantity).toFixed(3),
          unitPrice: D(l.it.unitPrice).toFixed(4),
          amount: l.amount.toFixed(2),
          igstRate: l.igstRate.toFixed(4),
          igstAmountInr: l.igst.toFixed(2),
        },
      });
    }

    const rodtep = sum(billItems.map((b) => D(b.rodtepAmount)));
    const drawback = sum(billItems.map((b) => D(b.drawbackAmount)));
    const claims: { scheme: 'RODTEP' | 'DUTY_DRAWBACK'; amount: ReturnType<typeof D>; entry: 'EXPECTED_RODTEP' | 'EXPECTED_DRAWBACK' }[] = [
      { scheme: 'RODTEP', amount: rodtep, entry: 'EXPECTED_RODTEP' },
      { scheme: 'DUTY_DRAWBACK', amount: drawback, entry: 'EXPECTED_DRAWBACK' },
    ];
    for (const c of claims.filter((x) => x.amount.gt(0))) {
      await tx.incentiveClaim.create({ data: { shippingBillId: bill.id, scheme: c.scheme, status: 'ELIGIBLE', claimAmountInr: c.amount.toFixed(2) } });
      await tx.financeLedgerEntry.create({
        data: {
          companyId: shipment.companyId,
          shipmentId: shipment.id,
          invoiceId: invoice.id,
          entryType: c.entry,
          reference: bill.sbNo,
          currencyCode: 'INR',
          amount: c.amount.toFixed(2),
          amountInr: c.amount.toFixed(2),
        },
      });
    }
    await recordStep(tx, { shipmentId: shipment.id }, 'ZERO_RATED_INCENTIVE_LOGGING', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'Invoice', entityId: invoice.id, action: 'CREATE', actorId: input.actorId, after: { invoiceNo: input.invoiceNo, lutId } });
    return { invoiceId: invoice.id, lutId, rodtepInr: rodtep.toFixed(2), drawbackInr: drawback.toFixed(2), alreadyLogged: false };
  });
}

// ── Step 13 — examination & Let Export Order ────────────────────────────────
export async function grantLeo(input: { shipmentId: number; leoNo: string; leoDate: Date; actorId?: number }) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'EXPORT' });
    const bill = await activeBill(tx, shipment.id);
    if (!bill) throw new DomainError('NO_SHIPPING_BILL', 'File the shipping bill first.', 409);
    if (bill.status === 'LEO_GRANTED') {
      if (bill.leoNo === input.leoNo) return { shippingBillId: bill.id, leoNo: bill.leoNo, alreadyGranted: true };
      throw new DomainError('LEO_ALREADY_GRANTED', `LEO ${bill.leoNo} is already recorded.`, 409);
    }
    if (shipment.status !== 'CUSTOMS_EXPORT_PROCESSING') {
      throw new DomainError('INVALID_STATUS', `LEO cannot be granted from status ${shipment.status}.`, 409);
    }
    await tx.shippingBill.update({ where: { id: bill.id }, data: { status: 'LEO_GRANTED', leoNo: input.leoNo, leoDate: input.leoDate } });
    await updateShipment(tx, shipment, {}, { to: 'EXPORT_LEO_GRANTED', actorId: input.actorId, reason: `LEO ${input.leoNo}` });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'LEO_GRANTED', at: input.leoDate, actorId: input.actorId, batches: 'all' });
    await recordStep(tx, { shipmentId: shipment.id }, 'CUSTOMS_EXAMINATION_LEO', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'ShippingBill', entityId: bill.id, action: 'UPDATE', actorId: input.actorId, after: { leoNo: input.leoNo } });
    return { shippingBillId: bill.id, leoNo: input.leoNo, alreadyGranted: false };
  });
}

// ── Step 14 — port terminal handling & loading ──────────────────────────────
export async function confirmLoading(input: { shipmentId: number; loadedAt: Date; actorId?: number }) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'EXPORT', allowedFrom: ['EXPORT_LEO_GRANTED', 'CUSTOMS_HOLD'] });
    const bill = await activeBill(tx, shipment.id);
    if (!bill || bill.status !== 'LEO_GRANTED') throw new DomainError('LEO_REQUIRED', 'Cargo cannot be loaded before the Let Export Order.', 422);

    const released = await releaseHolds(tx, shipment.id, input.loadedAt);
    await updateShipment(tx, shipment, {}, { to: 'LOADED', actorId: input.actorId, reason: 'Loaded', meta: { releasedHolds: released } });
    if (shipment.mode === 'SEA') {
      await tx.seaShipmentDetail.updateMany({ where: { shipmentId: shipment.id }, data: { loadedOnVesselAt: input.loadedAt } });
    } else {
      await tx.airShipmentDetail.updateMany({ where: { shipmentId: shipment.id }, data: { handedToAirlineAt: input.loadedAt } });
    }
    if (released > 0) {
      await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'CUSTOMS_HOLD_RELEASED', at: input.loadedAt, actorId: input.actorId, batches: 'all' });
    }
    await recordMilestone(tx, {
      shipmentId: shipment.id,
      milestone: shipment.mode === 'SEA' ? 'LOADED_ON_VESSEL' : 'LOADED_ON_AIRCRAFT',
      at: ms(input.loadedAt, 1),
      actorId: input.actorId,
      batches: 'all',
    });
    await recordStep(tx, { shipmentId: shipment.id }, 'PORT_TERMINAL_HANDLING_LOADING', 'DONE', { actorId: input.actorId });
    return { shipmentId: shipment.id, status: 'LOADED' as const, releasedHolds: released };
  });
}

// ── Step 15 — departure confirmation ────────────────────────────────────────
export async function confirmDeparture(input: {
  shipmentId: number;
  departedAt: Date;
  /** Bill of lading / airway bill number once the original is collected. */
  transportDocNo?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'EXPORT', allowedFrom: ['LOADED'] });
    await updateShipment(
      tx,
      shipment,
      { atd: input.departedAt, ...(input.transportDocNo ? { transportDocCollectedAt: input.departedAt } : {}) },
      { to: 'IN_TRANSIT', actorId: input.actorId, reason: 'Departed' },
    );
    if (input.transportDocNo) {
      if (shipment.mode === 'SEA') await tx.seaShipmentDetail.updateMany({ where: { shipmentId: shipment.id }, data: { mblNo: input.transportDocNo } });
      else await tx.airShipmentDetail.updateMany({ where: { shipmentId: shipment.id }, data: { mawbNo: input.transportDocNo } });
    }
    await recordMilestone(tx, {
      shipmentId: shipment.id,
      milestone: shipment.mode === 'SEA' ? 'VESSEL_DEPARTED' : 'FLIGHT_DEPARTED',
      at: input.departedAt,
      actorId: input.actorId,
      batches: 'all',
    });
    await recordStep(tx, { shipmentId: shipment.id }, 'DEPARTURE_CONFIRMATION', 'DONE', { actorId: input.actorId });
    return { shipmentId: shipment.id, status: 'IN_TRANSIT' as const, transportDocCollected: Boolean(input.transportDocNo) };
  });
}

// ── Step 16 — pre-arrival manifest filing (import) ──────────────────────────
export async function fileManifest(input: {
  shipmentId: number;
  type: ManifestType;
  referenceNo: string;
  ackNo?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, {
      direction: 'IMPORT',
      allowedFrom: ['BOOKED', 'IN_TRANSIT', 'AT_PORT', 'CUSTOMS_IMPORT_HOLD'],
    });
    const prior = await tx.manifestFiling.findFirst({ where: { shipmentId: shipment.id, type: input.type, referenceNo: input.referenceNo } });
    if (prior) return { manifestId: prior.id, alreadyFiled: true };

    const now = new Date();
    const m = await tx.manifestFiling.create({
      data: {
        shipmentId: shipment.id,
        type: input.type,
        referenceNo: input.referenceNo,
        status: input.ackNo ? 'ACCEPTED' : 'FILED',
        ackNo: input.ackNo ?? null,
        filedAt: now,
      },
    });
    await updateShipment(tx, shipment, { manifestFiled: true });
    await tx.icegateMessage.create({
      data: { shipmentId: shipment.id, messageType: `${input.type}_FILING`, direction: 'OUTBOUND', referenceNo: input.referenceNo },
    });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'MANIFEST_FILED', at: now, actorId: input.actorId, batches: 'all' });
    await ensureDirectionSteps(tx, shipment.id, 'IMPORT');
    await recordStep(tx, { shipmentId: shipment.id }, 'PRE_ARRIVAL_MANIFEST_FILING', 'DONE', { actorId: input.actorId });
    return { manifestId: m.id, alreadyFiled: false };
  });
}

// ── Step 17 — Bill of Entry submission (import) ─────────────────────────────
export async function submitBillOfEntry(input: {
  shipmentId: number;
  portId: number;
  boeNo: string;
  boeDate: Date;
  /** Customs-notified import rate: INR per 1 unit of the invoice currency. */
  exchangeRate: string;
  /** Assessable value per item as declared on the Bill of Entry (INR). */
  items: { shipmentItemId: number; assessableValueInr: string }[];
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'IMPORT', allowedFrom: ['CUSTOMS_IMPORT_HOLD'] });
    const prior = (await tx.billOfEntry.findMany({ where: { shipmentId: shipment.id } })).find((b) => b.status !== 'CANCELLED');
    if (prior) {
      if (prior.boeNo === input.boeNo) return { billOfEntryId: prior.id, boeNo: prior.boeNo, alreadyFiled: true };
      throw new DomainError('BOE_ALREADY_FILED', `Shipment already has Bill of Entry ${prior.boeNo}.`, 409);
    }
    const shipItems = await tx.shipmentItem.findMany({ where: { shipmentId: shipment.id } });
    const declared = new Map(input.items.map((i) => [i.shipmentItemId, i]));
    const missing = shipItems.filter((i) => !declared.has(i.id)).map((i) => i.id);
    const unknown = input.items.filter((i) => !shipItems.some((x) => x.id === i.shipmentItemId)).map((i) => i.shipmentItemId);
    if (missing.length || unknown.length) throw new DomainError('ITEMS_MISMATCH', 'Declare every shipment item exactly once.', 422, { missing, unknown });

    const rates = await tx.hsDutyRate.findMany({
      where: { hsCodeId: { in: [...new Set(shipItems.map((i) => i.hsCodeId))] }, countryCode: 'IN', effectiveFrom: { lte: input.boeDate } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const rateOf = new Map<number, (typeof rates)[number]>();
    for (const r of rates) {
      if (!rateOf.has(r.hsCodeId) && (!r.effectiveTo || r.effectiveTo >= input.boeDate)) rateOf.set(r.hsCodeId, r);
    }

    const rows = shipItems.map((it) => {
      const r = rateOf.get(it.hsCodeId);
      if (!r) throw new DomainError('NO_DUTY_RATE', `No India duty rate on file for HS code id ${it.hsCodeId}.`, 422);
      const av = round2(D(declared.get(it.id)!.assessableValueInr));
      const bcd = round2(av.mul(D(r.bcdRate)).div(100));
      const sws = round2(bcd.mul(D(r.swsRate)).div(100));
      const add = round2(av.mul(D(r.additionalDutyRate)).div(100));
      const igst = round2(av.plus(bcd).plus(sws).plus(add).mul(D(r.igstRate)).div(100));
      return { it, r, av, bcd, sws, add, igst, total: bcd.plus(sws).plus(add).plus(igst) };
    });
    const tot = (f: (r: (typeof rows)[number]) => ReturnType<typeof D>) => sum(rows.map(f));

    const boe = await tx.billOfEntry.create({
      data: {
        shipmentId: shipment.id,
        portId: input.portId,
        boeNo: input.boeNo,
        boeDate: input.boeDate,
        status: 'FILED',
        exchangeRate: D(input.exchangeRate).toFixed(6),
        assessableValueInr: tot((r) => r.av).toFixed(2),
        bcdAmount: tot((r) => r.bcd).toFixed(2),
        swsAmount: tot((r) => r.sws).toFixed(2),
        additionalDutyAmount: tot((r) => r.add).toFixed(2),
        igstAmount: tot((r) => r.igst).toFixed(2),
        totalDutyInr: tot((r) => r.total).toFixed(2),
      },
    });
    for (const x of rows) {
      await tx.billOfEntryItem.create({
        data: {
          billOfEntryId: boe.id,
          shipmentItemId: x.it.id,
          hsCodeId: x.it.hsCodeId,
          assessableValueInr: x.av.toFixed(2),
          bcdRate: D(x.r.bcdRate).toFixed(4),
          bcdAmount: x.bcd.toFixed(2),
          swsAmount: x.sws.toFixed(2),
          additionalDutyAmount: x.add.toFixed(2),
          igstRate: D(x.r.igstRate).toFixed(4),
          igstAmount: x.igst.toFixed(2),
          totalDutyInr: x.total.toFixed(2),
        },
      });
    }
    await tx.icegateMessage.create({ data: { shipmentId: shipment.id, messageType: 'BOE_FILING', direction: 'OUTBOUND', referenceNo: input.boeNo } });

    // Flag a big gap versus the latest landed-cost sheet's duty so a human looks before assessment.
    let warning: string | null = null;
    const sheets = await tx.landedCostSheet.findMany({ where: { shipmentId: shipment.id }, orderBy: { versionNo: 'desc' } });
    const sheet = sheets.find((s) => s.status !== 'SUPERSEDED');
    if (sheet) {
      const lines = await tx.landedCostLine.findMany({ where: { sheetId: sheet.id } });
      const planned = sum(lines.filter((l) => ['BASIC_CUSTOMS_DUTY', 'SOCIAL_WELFARE_SURCHARGE', 'ADDITIONAL_DUTY', 'IGST'].includes(l.component)).map((l) => D(l.amountInr)));
      const actual = tot((r) => r.total);
      if (planned.gt(0) && actual.minus(planned).abs().div(planned).gt(0.01)) {
        warning = `Declared duty ${actual.toFixed(2)} differs from the landed-cost estimate ${planned.toFixed(2)} by more than 1%.`;
      }
    }
    await ensureDirectionSteps(tx, shipment.id, 'IMPORT');
    await recordStep(tx, { shipmentId: shipment.id }, 'BILL_OF_ENTRY_SUBMISSION', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'BillOfEntry', entityId: boe.id, action: 'CREATE', actorId: input.actorId, after: { boeNo: input.boeNo, totalDutyInr: tot((r) => r.total).toFixed(2) } });
    return { billOfEntryId: boe.id, boeNo: input.boeNo, totalDutyInr: tot((r) => r.total).toFixed(2), warning, alreadyFiled: false };
  });
}

// ── Step 19 — duty assessment & Out of Charge (import) ──────────────────────
export async function grantOoc(input: { shipmentId: number; oocNo: string; oocAt: Date; dutyPaidAt: Date; actorId?: number }) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'IMPORT' });
    const boes = await tx.billOfEntry.findMany({ where: { shipmentId: shipment.id }, orderBy: { id: 'desc' } });
    const boe = boes.find((b) => b.status !== 'CANCELLED');
    if (!boe) throw new DomainError('NO_BOE', 'Submit the Bill of Entry first.', 409);
    if (boe.status === 'OOC_GRANTED') {
      if (boe.oocNo === input.oocNo) return { billOfEntryId: boe.id, oocNo: boe.oocNo, alreadyGranted: true };
      throw new DomainError('OOC_ALREADY_GRANTED', `OOC ${boe.oocNo} is already recorded.`, 409);
    }
    if (shipment.status !== 'CUSTOMS_IMPORT_HOLD') throw new DomainError('INVALID_STATUS', `OOC cannot be granted from status ${shipment.status}.`, 409);

    const full = await tx.shipment.findUnique({ where: { id: shipment.id } });
    if (!full || (full.pgaClearance !== 'APPROVED' && full.pgaClearance !== 'NOT_REQUIRED')) {
      throw new DomainError('PGA_PENDING', 'All regulatory clearances must be approved before Out of Charge.', 409, { pgaClearance: full?.pgaClearance });
    }
    if (full.pgaClearance === 'NOT_REQUIRED') {
      const row = await tx.consignmentStep.findFirst({ where: { shipmentId: shipment.id, stepCode: 'PGA_CLEARANCES' } });
      if (!row) await recordStep(tx, { shipmentId: shipment.id }, 'PGA_CLEARANCES', 'SKIPPED', { actorId: input.actorId });
    }

    await tx.billOfEntry.update({
      where: { id: boe.id },
      data: { status: 'OOC_GRANTED', oocNo: input.oocNo, oocAt: input.oocAt, dutyPaidAt: input.dutyPaidAt },
    });
    const released = await releaseHolds(tx, shipment.id, input.oocAt);
    await updateShipment(tx, shipment, {}, { to: 'CUSTOMS_RELEASED', actorId: input.actorId, reason: `OOC ${input.oocNo}`, meta: { releasedHolds: released } });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'CUSTOMS_HOLD_RELEASED', at: input.oocAt, actorId: input.actorId, batches: 'all' });
    await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'OOC_GRANTED', at: ms(input.oocAt, 1), actorId: input.actorId, batches: 'all' });
    await recordStep(tx, { shipmentId: shipment.id }, 'DUTY_ASSESSMENT_OOC', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'BillOfEntry', entityId: boe.id, action: 'STATUS_CHANGE', actorId: input.actorId, before: { status: boe.status }, after: { status: 'OOC_GRANTED', oocNo: input.oocNo } });
    return { billOfEntryId: boe.id, oocNo: input.oocNo, status: 'CUSTOMS_RELEASED' as const, releasedHolds: released, alreadyGranted: false };
  });
}
