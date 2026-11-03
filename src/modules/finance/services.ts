/**
 * Finance services: charge posting, landed-cost re-costing and finalisation (step 20), reconciliation (step 23).
 */
import type { AllocationBasis, LandedCostComponent } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { D, round2, round4, sum } from '@/lib/money';
import { runTx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';
import { computeLandedCostSheet, loadShipmentForCosting } from '@/modules/logistics/services/port-arrival.service';
import { loadShipment, updateShipment } from '@/modules/shared/shipment-ops';
import { COMPUTED_COMPONENTS } from './landed-cost.calculator';

// ── Post a real (or estimated) charge against a shipment ────────────────────
export async function postShipmentCharge(input: {
  shipmentId: number;
  component: LandedCostComponent;
  amount: string;
  currencyCode: string;
  allocationBasis?: AllocationBasis;
  isEstimated?: boolean;
  invoiceRef?: string;
  incurredOn: Date;
  containerId?: number;
  payeeId?: number;
  description?: string;
  actorId?: number;
}) {
  if (COMPUTED_COMPONENTS.has(input.component)) {
    throw new DomainError('COMPUTED_COMPONENT', `${input.component} is computed by the duty engine and cannot be posted as a charge.`, 422);
  }
  if (D(input.amount).lte(0)) throw new DomainError('BAD_AMOUNT', 'Charge amount must be positive.', 422);
  return runTx(async (tx) => {
    await loadShipment(tx, input.shipmentId);
    const c = await tx.shipmentCharge.create({
      data: {
        shipmentId: input.shipmentId,
        containerId: input.containerId ?? null,
        payeeId: input.payeeId ?? null,
        component: input.component,
        description: input.description ?? null,
        amount: D(input.amount).toFixed(2),
        currencyCode: input.currencyCode,
        allocationBasis: input.allocationBasis ?? 'VALUE',
        isEstimated: input.isEstimated ?? false,
        invoiceRef: input.invoiceRef ?? null,
        incurredOn: input.incurredOn,
      },
    });
    await writeAudit(tx, { entity: 'ShipmentCharge', entityId: c.id, action: 'CREATE', actorId: input.actorId, after: { component: input.component, amount: input.amount, isEstimated: input.isEstimated ?? false } });
    return { chargeId: c.id };
  });
}

// ── Re-cost with the charges posted so far ──────────────────────────────────
export async function recostLandedCost(input: { shipmentId: number; igstRecoverable?: boolean; actorId?: number; asOf?: Date }) {
  return runTx(async (tx) => {
    const shipment = await loadShipmentForCosting(tx, input.shipmentId);
    if (!shipment) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${input.shipmentId} does not exist.`, 404);
    if (shipment.items.length === 0) throw new DomainError('NO_ITEMS', 'Shipment has no items to cost.', 422);
    if (['DRAFT', 'CLOSED', 'CANCELLED'].includes(shipment.status)) {
      throw new DomainError('INVALID_STATUS', `Cannot re-cost a shipment in status ${shipment.status}.`, 409);
    }
    const warnings: string[] = [];
    const { sheet, calc } = await computeLandedCostSheet(tx, shipment, shipment.containers, {
      asOf: input.asOf ?? new Date(),
      igstRecoverable: input.igstRecoverable ?? true,
      actorId: input.actorId,
      warnings,
    });
    await writeAudit(tx, { entity: 'LandedCostSheet', entityId: sheet.id, action: 'CREATE', actorId: input.actorId, after: { versionNo: sheet.versionNo, status: sheet.status } });
    return { sheetId: sheet.id, versionNo: sheet.versionNo, status: sheet.status, totalInr: calc.totalInr.toFixed(2), hasEstimates: calc.hasEstimates, warnings };
  });
}

// ── Step 20 — finalise landed cost & update product cost basis ──────────────
export async function finalizeLandedCost(input: { shipmentId: number; acceptEstimates?: boolean; actorId?: number }) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { direction: 'IMPORT', allowedFrom: ['CUSTOMS_RELEASED', 'DELIVERED'] });
    const sheets = await tx.landedCostSheet.findMany({ where: { shipmentId: shipment.id }, orderBy: { versionNo: 'desc' } });
    const sheet = sheets.find((s) => s.status !== 'SUPERSEDED');
    if (!sheet) throw new DomainError('NO_SHEET', 'No landed-cost sheet exists; process the port arrival first.', 409);
    if (sheet.status === 'FINAL') return { sheetId: sheet.id, status: 'FINAL' as const, totalInr: D(sheet.totalInr).toFixed(2), alreadyFinal: true };
    if (sheet.hasEstimates && !input.acceptEstimates) {
      throw new DomainError('ESTIMATES_PENDING', 'The sheet still uses estimated charges. Post actual charges and re-cost, or pass acceptEstimates.', 409);
    }

    await tx.landedCostSheet.update({ where: { id: sheet.id }, data: { status: 'FINAL' } });

    // Product cost basis = total landed INR / quantity, per product across this shipment's items.
    const items = await tx.landedCostItem.findMany({ where: { sheetId: sheet.id } });
    const shipItems = await tx.shipmentItem.findMany({ where: { shipmentId: shipment.id } });
    const productOf = new Map(shipItems.map((i) => [i.id, i.productId]));
    const agg = new Map<number, { total: ReturnType<typeof D>; qty: ReturnType<typeof D> }>();
    for (const it of items) {
      const pid = productOf.get(it.shipmentItemId);
      if (pid === undefined) continue;
      const cur = agg.get(pid) ?? { total: D(0), qty: D(0) };
      agg.set(pid, { total: cur.total.plus(D(it.totalInr)), qty: cur.qty.plus(D(it.quantity)) });
    }
    const now = new Date();
    for (const [productId, a] of agg) {
      if (a.qty.gt(0)) {
        await tx.product.update({ where: { id: productId }, data: { unitLandedCostInr: round4(a.total.div(a.qty)).toFixed(4), unitLandedCostAt: now } });
      }
    }

    const full = await tx.shipment.findUnique({ where: { id: shipment.id } });
    await tx.financeLedgerEntry.create({
      data: {
        companyId: full!.companyId,
        shipmentId: shipment.id,
        entryType: 'LANDED_COST_POSTED',
        reference: `LC-SHEET-${sheet.id}`,
        currencyCode: 'INR',
        amount: D(sheet.totalInr).toFixed(2),
        amountInr: D(sheet.totalInr).toFixed(2),
        note: sheet.hasEstimates ? 'Finalised with estimated charges accepted.' : null,
      },
    });
    await recordStep(tx, { shipmentId: shipment.id }, 'LANDED_COST_CONSOLIDATION', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'LandedCostSheet', entityId: sheet.id, action: 'STATUS_CHANGE', actorId: input.actorId, before: { status: sheet.status }, after: { status: 'FINAL' } });
    return { sheetId: sheet.id, status: 'FINAL' as const, totalInr: D(sheet.totalInr).toFixed(2), productsUpdated: agg.size, alreadyFinal: false };
  });
}

// ── Step 23 — financial reconciliation ──────────────────────────────────────
export async function reconcileShipment(input: {
  shipmentId: number;
  receipts: { currencyCode: string; amount: string; rateToInr: string; receivedAt: Date; reference?: string }[];
  letterOfCreditId?: number;
  forwardContractId?: number;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await loadShipment(tx, input.shipmentId, { allowedFrom: ['DELIVERED'] });
    const full = await tx.shipment.findUnique({ where: { id: shipment.id } });
    const companyId = full!.companyId;
    const invoices = await tx.invoice.findMany({ where: { shipmentId: shipment.id, type: 'COMMERCIAL' } });
    const invoice = invoices[0] ?? null;

    const receipts = input.receipts.map((r) => ({ ...r, amt: D(r.amount), rate: D(r.rateToInr) }));
    if (receipts.some((r) => r.amt.lte(0) || r.rate.lte(0))) throw new DomainError('BAD_AMOUNT', 'Receipt amounts and rates must be positive.', 422);
    if (invoice && receipts.some((r) => r.currencyCode !== invoice.currencyCode)) {
      throw new DomainError('CURRENCY_MISMATCH', `Receipts must be in the invoice currency ${invoice.currencyCode}.`, 422);
    }

    const fc = input.forwardContractId ? await tx.forwardContract.findUnique({ where: { id: input.forwardContractId } }) : null;
    if (input.forwardContractId && !fc) throw new DomainError('FORWARD_NOT_FOUND', `Forward contract ${input.forwardContractId} does not exist.`, 404);
    const received = sum(receipts.map((r) => r.amt));
    if (fc) {
      const newUtilised = D(fc.utilizedAmount).plus(received);
      if (newUtilised.gt(D(fc.notionalAmount))) throw new DomainError('OVER_UTILISED', 'Receipts exceed the forward contract\'s remaining notional.', 422);
    }

    for (const r of receipts) {
      await tx.financeLedgerEntry.create({
        data: {
          companyId,
          shipmentId: shipment.id,
          invoiceId: invoice?.id ?? null,
          letterOfCreditId: input.letterOfCreditId ?? full!.letterOfCreditId ?? null,
          entryType: 'COLLECTION_RECEIVED',
          reference: r.reference ?? null,
          currencyCode: r.currencyCode,
          amount: r.amt.toFixed(2),
          fixedRate: r.rate.toFixed(6),
          amountInr: round2(r.amt.mul(r.rate)).toFixed(2),
          postedAt: r.receivedAt,
        },
      });
    }

    let fxDifferenceInr = D(0);
    if (fc) {
      const sign = fc.side === 'SELL_FOREIGN' ? 1 : -1; // exporter sells foreign: contract rate above spot = gain
      for (const r of receipts) {
        const diff = round2(r.amt.mul(D(fc.contractRate).minus(r.rate)).mul(sign));
        fxDifferenceInr = fxDifferenceInr.plus(diff);
        await tx.financeLedgerEntry.create({
          data: {
            companyId,
            shipmentId: shipment.id,
            forwardContractId: fc.id,
            entryType: 'FX_DIFFERENCE_SETTLED',
            reference: fc.contractNo,
            currencyCode: 'INR',
            amount: diff.toFixed(2),
            fixedRate: D(fc.contractRate).toFixed(6),
            amountInr: diff.toFixed(2),
            postedAt: r.receivedAt,
          },
        });
      }
      const utilised = D(fc.utilizedAmount).plus(received);
      await tx.forwardContract.update({
        where: { id: fc.id },
        data: { utilizedAmount: utilised.toFixed(2), status: utilised.eq(D(fc.notionalAmount)) ? 'UTILIZED' : 'PARTIALLY_UTILIZED' },
      });
    }

    let settled = true;
    let invoiceStatus: string | null = null;
    if (invoice) {
      const earlier = await tx.financeLedgerEntry.findMany({ where: { invoiceId: invoice.id, entryType: 'COLLECTION_RECEIVED' } });
      const collected = sum(earlier.map((e) => D(e.amount))); // includes the rows just written
      settled = collected.gte(D(invoice.totalAmount));
      invoiceStatus = settled ? 'SETTLED' : 'PARTIALLY_PAID';
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: invoiceStatus as never } });
    }

    const lcId = input.letterOfCreditId ?? full!.letterOfCreditId;
    if (lcId && settled) {
      await tx.letterOfCredit.update({ where: { id: lcId }, data: { status: 'PAID' } });
      await tx.lcMilestone.create({ data: { lcId, type: 'PAYMENT_RECEIVED', status: 'DONE', completedAt: new Date() } });
    }

    if (settled) {
      await recordStep(tx, { shipmentId: shipment.id }, 'FINANCIAL_RECONCILIATION', 'DONE', { actorId: input.actorId });
      await updateShipment(tx, shipment, {}, { to: 'CLOSED', actorId: input.actorId, reason: 'Financially reconciled' });
    } else {
      await recordStep(tx, { shipmentId: shipment.id }, 'FINANCIAL_RECONCILIATION', 'IN_PROGRESS', { actorId: input.actorId });
    }
    await writeAudit(tx, { entity: 'Shipment', entityId: shipment.id, action: 'UPDATE', actorId: input.actorId, after: { reconciled: settled, received: received.toFixed(2) } });
    return {
      shipmentId: shipment.id,
      invoiceStatus,
      settled,
      receivedAmount: received.toFixed(2),
      fxDifferenceInr: fxDifferenceInr.toFixed(2),
      shipmentStatus: settled ? 'CLOSED' : 'DELIVERED',
    };
  });
}
