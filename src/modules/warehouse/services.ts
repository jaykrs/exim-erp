/**
 * Stage 2 — Warehouse processing (checklist steps 5–7): inward inspection, grading, traceability tags.
 */
import type { GradeTier, InspectionResult, TagType } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { D, sum } from '@/lib/money';
import { runTx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';

// ── Step 5 — inward dock inspection ─────────────────────────────────────────
export interface InwardLineInput {
  purchaseOrderLineId?: number;
  productId: number;
  receivedQty: string;
  acceptedQty: string;
  rejectedQty?: string;
  /** Procurement cost per unit in INR. Optional only when the PO is in INR and the line is linked to a PO line. */
  unitCostInr?: string;
  manufacturedOn?: Date;
  expiresOn?: Date;
  inspection: { result: InspectionResult; sampleSize?: string; defectPct?: string; notes?: string };
}

export interface InwardInput {
  grnNo: string;
  warehouseId: number;
  vendorId: number;
  purchaseOrderId?: number;
  receivedAt: Date;
  vehicleNo?: string;
  locationId?: number;
  inspectorId?: number;
  actorId?: number;
  lines: InwardLineInput[];
}

export async function recordInwardInspection(input: InwardInput) {
  return runTx(async (tx) => {
    const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse) throw new DomainError('WAREHOUSE_NOT_FOUND', `Warehouse ${input.warehouseId} does not exist.`, 404);
    const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId } });
    if (!vendor) throw new DomainError('VENDOR_NOT_FOUND', `Vendor ${input.vendorId} does not exist.`, 404);
    if (vendor.status !== 'VERIFIED') throw new DomainError('VENDOR_NOT_VERIFIED', 'Goods can only be received from a verified vendor.', 409);

    let po: { id: number; vendorId: number; status: string; currencyCode: string } | null = null;
    const poLines = new Map<number, { id: number; quantity: string; unitPrice: string }>();
    if (input.purchaseOrderId) {
      po = await tx.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId } });
      if (!po) throw new DomainError('PO_NOT_FOUND', `Purchase order ${input.purchaseOrderId} does not exist.`, 404);
      if (po.vendorId !== vendor.id) throw new DomainError('PO_VENDOR_MISMATCH', 'The PO belongs to a different vendor.', 422);
      if (po.status !== 'AWAITING_PRODUCTION' && po.status !== 'PARTIALLY_RECEIVED') {
        throw new DomainError('INVALID_PO_STATUS', `PO is ${po.status}; goods can only be received against AWAITING_PRODUCTION or PARTIALLY_RECEIVED.`, 409);
      }
      const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
      for (const l of lines) poLines.set(l.id, { id: l.id, quantity: String(l.quantity), unitPrice: String(l.unitPrice) });
    }

    // Validate every line before writing anything.
    const checked = input.lines.map((l, idx) => {
      const received = D(l.receivedQty);
      const accepted = D(l.acceptedQty);
      const rejected = D(l.rejectedQty ?? 0);
      if (received.lte(0) || accepted.lt(0) || rejected.lt(0)) throw new DomainError('BAD_QTY', `Line ${idx + 1}: quantities must be positive.`, 422);
      if (!accepted.plus(rejected).eq(received)) {
        throw new DomainError('QTY_MISMATCH', `Line ${idx + 1}: accepted + rejected must equal received.`, 422);
      }
      const failed = l.inspection.result === 'FAILED';
      if (failed && accepted.gt(0)) throw new DomainError('FAILED_BUT_ACCEPTED', `Line ${idx + 1}: a failed inspection cannot accept stock.`, 422);
      if (l.inspection.result === 'PENDING') throw new DomainError('INSPECTION_PENDING', `Line ${idx + 1}: record a final inspection result.`, 422);

      let cost = l.unitCostInr ? D(l.unitCostInr) : null;
      if (!cost && l.purchaseOrderLineId && po?.currencyCode === 'INR') {
        const pl = poLines.get(l.purchaseOrderLineId);
        if (pl) cost = D(pl.unitPrice);
      }
      if (!cost && accepted.gt(0)) throw new DomainError('COST_REQUIRED', `Line ${idx + 1}: provide unitCostInr (the PO is not in INR).`, 422);
      if (l.purchaseOrderLineId && !poLines.has(l.purchaseOrderLineId)) {
        throw new DomainError('PO_LINE_MISMATCH', `Line ${idx + 1}: PO line is not on this purchase order.`, 422);
      }
      return { l, received, accepted, rejected, cost, failed };
    });

    const allFailed = checked.every((c) => c.failed);
    const grn = await tx.inwardReceipt.create({
      data: {
        grnNo: input.grnNo,
        warehouseId: warehouse.id,
        vendorId: vendor.id,
        purchaseOrderId: po?.id ?? null,
        status: allFailed ? 'REJECTED' : 'COMPLETED',
        receivedAt: input.receivedAt,
        vehicleNo: input.vehicleNo ?? null,
      },
    });

    const batches: { id: number; batchNo: string; quantity: string }[] = [];
    for (const [idx, c] of checked.entries()) {
      const line = await tx.inwardReceiptLine.create({
        data: {
          inwardReceiptId: grn.id,
          purchaseOrderLineId: c.l.purchaseOrderLineId ?? null,
          productId: c.l.productId,
          receivedQty: c.received.toFixed(3),
          acceptedQty: c.accepted.toFixed(3),
          rejectedQty: c.rejected.toFixed(3),
        },
      });
      await tx.inspection.create({
        data: {
          inwardLineId: line.id,
          inspectorId: input.inspectorId ?? null,
          result: c.l.inspection.result,
          sampleSize: c.l.inspection.sampleSize ? D(c.l.inspection.sampleSize).toFixed(3) : null,
          defectPct: c.l.inspection.defectPct ? D(c.l.inspection.defectPct).toFixed(2) : null,
          notes: c.l.inspection.notes ?? null,
          inspectedAt: input.receivedAt,
        },
      });
      if (c.accepted.gt(0) && c.cost) {
        const batch = await tx.batch.create({
          data: {
            batchNo: `${input.grnNo}-${idx + 1}`,
            productId: c.l.productId,
            vendorId: vendor.id,
            inwardLineId: line.id,
            warehouseId: warehouse.id,
            locationId: input.locationId ?? null,
            status: 'RECEIVED_UNSORTED',
            quantity: c.accepted.toFixed(3),
            availableQty: c.accepted.toFixed(3),
            unitCostInr: c.cost.toFixed(4),
            manufacturedOn: c.l.manufacturedOn ?? null,
            expiresOn: c.l.expiresOn ?? null,
            currentMilestone: 'GOODS_INWARDED',
            currentMilestoneAt: input.receivedAt,
            currentLocationText: warehouse.name,
          },
        });
        await recordStep(tx, { batchId: batch.id }, 'INWARD_DOCK_INSPECTION', 'DONE', {
          actorId: input.actorId,
          note: c.l.inspection.result === 'PASSED_WITH_DEVIATION' ? c.l.inspection.notes : undefined,
        });
        batches.push({ id: batch.id, batchNo: batch.batchNo, quantity: c.accepted.toFixed(3) });
      }
    }

    // Roll PO status up from everything accepted against it so far.
    let poStatus: string | null = null;
    if (po) {
      const accepted = await tx.inwardReceiptLine.findMany({ where: { purchaseOrderLineId: { in: [...poLines.keys()] } } });
      const byLine = new Map<number, ReturnType<typeof D>>();
      for (const a of accepted) {
        if (a.purchaseOrderLineId == null) continue;
        byLine.set(a.purchaseOrderLineId, (byLine.get(a.purchaseOrderLineId) ?? D(0)).plus(D(a.acceptedQty)));
      }
      const complete = [...poLines.values()].every((pl) => (byLine.get(pl.id) ?? D(0)).gte(D(pl.quantity)));
      const any = sum([...byLine.values()]).gt(0);
      poStatus = complete ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : po.status;
      if (poStatus !== po.status) await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: poStatus } });
    }

    await writeAudit(tx, { entity: 'InwardReceipt', entityId: grn.id, action: 'CREATE', actorId: input.actorId, after: { grnNo: input.grnNo, batches: batches.length } });
    return { inwardReceiptId: grn.id, grnNo: input.grnNo, status: allFailed ? 'REJECTED' : 'COMPLETED', purchaseOrderStatus: poStatus, batches };
  });
}

// ── Step 6 — sorting & quality grading ──────────────────────────────────────
export async function gradeBatch(input: {
  batchId: number;
  grades: { gradeTier: GradeTier; weightKg: string; quantity: string }[];
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', `Batch ${input.batchId} does not exist.`, 404);
    const existing = await tx.batchGrade.findMany({ where: { batchId: batch.id } });
    if (existing.length > 0) throw new DomainError('ALREADY_GRADED', 'This batch has already been graded.', 409);
    if (batch.status !== 'RECEIVED_UNSORTED') {
      throw new DomainError('INVALID_BATCH_STATUS', `Batch is ${batch.status}; only RECEIVED_UNSORTED batches can be graded.`, 409);
    }

    const tiers = input.grades.map((g) => g.gradeTier);
    if (new Set(tiers).size !== tiers.length) throw new DomainError('DUPLICATE_GRADE', 'Each grade tier may appear once.', 422);
    if (tiers.includes('UNGRADED') && tiers.length > 1) throw new DomainError('UNGRADED_MIXED', 'UNGRADED cannot be combined with other tiers.', 422);

    const parts = input.grades.map((g) => ({ ...g, q: D(g.quantity), w: D(g.weightKg) }));
    if (parts.some((p) => p.q.lt(0) || p.w.lt(0))) throw new DomainError('BAD_QTY', 'Quantities and weights cannot be negative.', 422);
    const total = sum(parts.map((p) => p.q));
    if (!total.eq(D(batch.quantity))) {
      throw new DomainError('GRADE_SUM_MISMATCH', `Graded quantity ${total.toFixed(3)} must equal the batch quantity ${D(batch.quantity).toFixed(3)}.`, 422);
    }

    for (const p of parts) {
      await tx.batchGrade.create({
        data: {
          batchId: batch.id,
          gradeTier: p.gradeTier,
          weightKg: p.w.toFixed(3),
          quantity: p.q.toFixed(3),
          availableQty: p.gradeTier === 'REJECT' ? '0.000' : p.q.toFixed(3),
        },
      });
    }
    const sellable = sum(parts.filter((p) => p.gradeTier !== 'REJECT').map((p) => p.q));
    const status = sellable.gt(0) ? 'AVAILABLE' : 'QUARANTINE';
    await tx.batch.update({
      where: { id: batch.id },
      data: { status, availableQty: sellable.toFixed(3), currentMilestone: 'GRADED', currentMilestoneAt: new Date() },
    });
    await recordStep(tx, { batchId: batch.id }, 'SORTING_QUALITY_GRADING', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'Batch', entityId: batch.id, action: 'UPDATE', actorId: input.actorId, before: { status: batch.status }, after: { status, tiers } });
    return { batchId: batch.id, status, sellableQty: sellable.toFixed(3), grades: parts.map((p) => ({ gradeTier: p.gradeTier, quantity: p.q.toFixed(3) })) };
  });
}

// ── Step 7 — traceability tokens ────────────────────────────────────────────
export async function generateTraceTags(input: { batchId: number; packageCount?: number; tagType?: TagType; actorId?: number; year?: number }) {
  return runTx(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', `Batch ${input.batchId} does not exist.`, 404);

    if (batch.traceabilityCode) {
      const tags = await tx.traceTag.findMany({ where: { batchId: batch.id } });
      return { batchId: batch.id, traceabilityCode: batch.traceabilityCode, tagCount: tags.length, alreadyGenerated: true };
    }
    const grades = await tx.batchGrade.findMany({ where: { batchId: batch.id } });
    if (grades.length === 0) throw new DomainError('NOT_GRADED', 'Grade the batch before generating tags.', 409);

    const year = input.year ?? new Date().getUTCFullYear();
    const prefix = `LOT-${year}-`;
    const last = await tx.batch.findFirst({ where: { traceabilityCode: { startsWith: prefix } }, orderBy: { traceabilityCode: 'desc' } });
    const lastSeq = last?.traceabilityCode ? Number(last.traceabilityCode.slice(prefix.length)) : 0;
    const code = `${prefix}${String(lastSeq + 1).padStart(4, '0')}`;

    const count = Math.min(Math.max(input.packageCount ?? 1, 1), 5000);
    const tagType = input.tagType ?? 'GS1_128';
    await tx.traceTag.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        batchId: batch.id,
        tagType,
        code: `${code}-${String(i + 1).padStart(4, '0')}`,
      })),
    });
    await tx.batch.update({
      where: { id: batch.id },
      data: { traceabilityCode: code, currentMilestone: 'TAGGED', currentMilestoneAt: new Date() },
    });
    await recordStep(tx, { batchId: batch.id }, 'TRACEABILITY_TOKEN_GENERATION', 'DONE', { actorId: input.actorId });
    await writeAudit(tx, { entity: 'Batch', entityId: batch.id, action: 'UPDATE', actorId: input.actorId, after: { traceabilityCode: code, tags: count } });
    return { batchId: batch.id, traceabilityCode: code, tagCount: count, alreadyGenerated: false };
  });
}
