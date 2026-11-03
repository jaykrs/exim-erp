/**
 * Stage 3 — packaging & compliance testing (steps 8–10) plus PGA clearance handling (step 18).
 */
import type { LabProvider, LabTestStatus, PackagingType, Ispm15Treatment } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { runTx, type Tx } from '@/lib/tx';
import { recordStep } from '@/modules/consignment/step-tracker';
import { recordMilestone } from '@/modules/shared/shipment-ops';

const WOODEN: PackagingType[] = ['WOODEN_PALLET', 'WOODEN_CRATE'];
const ISPM15_TREATMENTS: Ispm15Treatment[] = ['HT', 'MB', 'DH', 'SF'];

async function loadBatch(tx: Tx, batchId: number) {
  const batch = await tx.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw new DomainError('BATCH_NOT_FOUND', `Batch ${batchId} does not exist.`, 404);
  return batch;
}

/** When ISPM 15, PSI/lab and label validation are all DONE, the batch is ready for dispatch. */
async function markReadyIfCompliant(tx: Tx, batchId: number): Promise<boolean> {
  const rows = await tx.consignmentStep.findMany({
    where: { batchId, stepCode: { in: ['ISPM15_PACKAGING', 'PSI_LAB_TESTING', 'TARGET_MARKET_LABEL_VALIDATION'] } },
  });
  const ready = rows.length === 3 && rows.every((r) => r.status === 'DONE');
  if (ready) await tx.batch.update({ where: { id: batchId }, data: { currentMilestone: 'READY_FOR_DISPATCH', currentMilestoneAt: new Date() } });
  return ready;
}

// ── Step 8 — ISPM 15 phytosanitary packaging ────────────────────────────────
export async function verifyIspm15(input: {
  batchId: number;
  shipmentId?: number;
  packagingType: PackagingType;
  treatment: Ispm15Treatment;
  markNo?: string;
  treatmentCertNo?: string;
  treatmentProvider?: string;
  treatedOn?: Date;
  packageCount?: number;
  verifierId?: number;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const batch = await loadBatch(tx, input.batchId);
    const wooden = WOODEN.includes(input.packagingType);
    if (wooden) {
      if (!ISPM15_TREATMENTS.includes(input.treatment)) {
        throw new DomainError('ISPM15_TREATMENT_REQUIRED', 'Wooden packaging needs HT, MB, DH or SF treatment.', 422);
      }
      if (!input.markNo || !input.treatmentCertNo || !input.treatedOn) {
        throw new DomainError('ISPM15_EVIDENCE_REQUIRED', 'Wooden packaging needs the ISPM 15 mark number, treatment certificate and treatment date.', 422);
      }
    }
    const now = new Date();
    const record = await tx.packagingRecord.create({
      data: {
        batchId: batch.id,
        shipmentId: input.shipmentId ?? null,
        packagingType: input.packagingType,
        ispm15Treatment: wooden ? input.treatment : 'NOT_APPLICABLE',
        ispm15MarkNo: wooden ? input.markNo! : null,
        treatmentCertNo: wooden ? input.treatmentCertNo! : null,
        treatmentProvider: wooden ? input.treatmentProvider ?? null : null,
        treatedOn: wooden ? input.treatedOn! : null,
        ispm15Certified: true,
        ispm15VerifiedById: input.verifierId ?? input.actorId ?? null,
        ispm15VerifiedAt: now,
        packageCount: input.packageCount ?? null,
        packedAt: now,
      },
    });
    await tx.batch.update({
      where: { id: batch.id },
      data: {
        currentMilestone: 'PACKED',
        currentMilestoneAt: now,
        ...(batch.status === 'AVAILABLE' || batch.status === 'RESERVED' ? { status: 'PACKED' } : {}),
      },
    });
    await recordStep(tx, { batchId: batch.id }, 'ISPM15_PACKAGING', 'DONE', { actorId: input.actorId, evidenceUrl: undefined });
    const ready = await markReadyIfCompliant(tx, batch.id);
    await writeAudit(tx, { entity: 'PackagingRecord', entityId: record.id, action: 'CREATE', actorId: input.actorId, after: { batchId: batch.id, wooden } });
    return { packagingRecordId: record.id, ispm15Certified: true, readyForDispatch: ready };
  });
}

// ── Step 9 — PSI & lab testing ──────────────────────────────────────────────
export async function recordLabTest(input: {
  batchId: number;
  provider: LabProvider;
  testType: string;
  referenceNo?: string;
  status: LabTestStatus;
  sampleSentAt?: Date;
  reportReceivedAt?: Date;
  validTill?: Date;
  reportUrl?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const batch = await loadBatch(tx, input.batchId);
    if (input.status === 'PASSED' && !input.reportUrl) {
      throw new DomainError('REPORT_REQUIRED', 'A passed test needs the lab report URL as evidence.', 422);
    }
    const now = new Date();
    const concluded = input.status === 'PASSED' || input.status === 'FAILED';
    const test = await tx.labTest.create({
      data: {
        batchId: batch.id,
        provider: input.provider,
        referenceNo: input.referenceNo ?? null,
        testType: input.testType,
        status: input.status,
        sampleSentAt: input.sampleSentAt ?? (input.status === 'SAMPLE_DISPATCHED' ? now : null),
        reportReceivedAt: input.reportReceivedAt ?? (concluded ? now : null),
        validTill: input.validTill ?? null,
        reportUrl: input.reportUrl ?? null,
      },
    });

    // Batch passes only when the LATEST result of every test type is PASSED.
    const all = await tx.labTest.findMany({ where: { batchId: batch.id } });
    const latest = new Map<string, { id: number; status: LabTestStatus }>();
    for (const t of all) {
      const cur = latest.get(t.testType);
      if (!cur || t.id > cur.id) latest.set(t.testType, { id: t.id, status: t.status });
    }
    const allPassed = [...latest.values()].every((t) => t.status === 'PASSED');
    const anyFailed = [...latest.values()].some((t) => t.status === 'FAILED');

    let compliance: 'PENDING' | 'PASSED' | 'FAILED' = 'PENDING';
    let stepStatus: 'IN_PROGRESS' | 'DONE' | 'BLOCKED' = 'IN_PROGRESS';
    const data: Record<string, unknown> = {};
    if (anyFailed) {
      compliance = 'FAILED';
      stepStatus = 'BLOCKED';
      data.status = 'ON_HOLD';
    } else if (allPassed) {
      compliance = 'PASSED';
      stepStatus = 'DONE';
      data.currentMilestone = 'LAB_CLEARED';
      data.currentMilestoneAt = now;
      if (batch.status === 'ON_HOLD') data.status = 'AVAILABLE';
    } else if (input.status === 'SAMPLE_DISPATCHED') {
      data.currentMilestone = 'LAB_SAMPLE_DISPATCHED';
      data.currentMilestoneAt = now;
    }
    await tx.batch.update({ where: { id: batch.id }, data: { complianceStatus: compliance, ...data } });
    await recordStep(tx, { batchId: batch.id }, 'PSI_LAB_TESTING', stepStatus, {
      actorId: input.actorId,
      reopen: true,
      evidenceUrl: input.reportUrl,
    });
    const ready = stepStatus === 'DONE' ? await markReadyIfCompliant(tx, batch.id) : false;
    await writeAudit(tx, { entity: 'LabTest', entityId: test.id, action: 'CREATE', actorId: input.actorId, after: { batchId: batch.id, status: input.status } });
    return { labTestId: test.id, complianceStatus: compliance, step: stepStatus, readyForDispatch: ready };
  });
}

// ── Step 10 — target-market label validation ────────────────────────────────
export async function validateLabel(input: {
  batchId: number;
  targetMarket: string;
  ruleSet: string;
  /** Rule violations found; empty/absent = label passes. */
  issues?: string[];
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const batch = await loadBatch(tx, input.batchId);
    const issues = input.issues ?? [];
    const passed = issues.length === 0;
    const record = await tx.packagingRecord.findFirst({ where: { batchId: batch.id }, orderBy: { id: 'desc' } });
    if (passed && !record) throw new DomainError('NO_PACKAGING_RECORD', 'Record packaging (ISPM 15 step) before approving the label.', 409);

    const now = new Date();
    const v = await tx.labelValidation.create({
      data: {
        batchId: batch.id,
        targetMarket: input.targetMarket,
        ruleSet: input.ruleSet,
        status: passed ? 'PASSED' : 'FAILED',
        issues: issues.length ? issues : undefined,
        validatedAt: now,
      },
    });
    if (record) await tx.packagingRecord.update({ where: { id: record.id }, data: { labelApproved: passed } });
    if (passed) await tx.batch.update({ where: { id: batch.id }, data: { currentMilestone: 'LABEL_VALIDATED', currentMilestoneAt: now } });
    await recordStep(tx, { batchId: batch.id }, 'TARGET_MARKET_LABEL_VALIDATION', passed ? 'DONE' : 'BLOCKED', {
      actorId: input.actorId,
      reopen: true,
      note: passed ? undefined : issues.join('; ').slice(0, 250),
    });
    const ready = passed ? await markReadyIfCompliant(tx, batch.id) : false;
    return { labelValidationId: v.id, status: passed ? 'PASSED' : 'FAILED', issues, readyForDispatch: ready };
  });
}

// ── Step 18 — PGA clearances ────────────────────────────────────────────────
export type ClearanceAction = 'SUBMIT' | 'QUERY' | 'SAMPLE' | 'APPROVE' | 'REJECT' | 'WAIVE';

const ACTION_RESULT: Record<ClearanceAction, { status: string; event: string }> = {
  SUBMIT: { status: 'SUBMITTED', event: 'SUBMITTED' },
  QUERY: { status: 'QUERY_RAISED', event: 'QUERY_RAISED' },
  SAMPLE: { status: 'SAMPLE_DRAWN', event: 'SAMPLE_DRAWN' },
  APPROVE: { status: 'APPROVED', event: 'APPROVED' },
  REJECT: { status: 'REJECTED', event: 'REJECTED' },
  WAIVE: { status: 'NOT_REQUIRED', event: 'WAIVED' },
};
const OPEN = ['REQUIRED', 'SUBMITTED', 'UNDER_REVIEW', 'QUERY_RAISED', 'SAMPLE_DRAWN'];
const ALLOWED_FROM: Record<ClearanceAction, string[]> = {
  SUBMIT: ['REQUIRED', 'QUERY_RAISED', 'REJECTED'],
  QUERY: ['SUBMITTED', 'UNDER_REVIEW', 'SAMPLE_DRAWN'],
  SAMPLE: ['SUBMITTED', 'UNDER_REVIEW', 'QUERY_RAISED'],
  APPROVE: ['SUBMITTED', 'UNDER_REVIEW', 'QUERY_RAISED', 'SAMPLE_DRAWN'],
  REJECT: ['SUBMITTED', 'UNDER_REVIEW', 'QUERY_RAISED', 'SAMPLE_DRAWN'],
  WAIVE: OPEN,
};

export async function resolveClearance(input: {
  shipmentId: number;
  board: string;
  action: ClearanceAction;
  applicationNo?: string;
  referenceNo?: string;
  validTill?: Date;
  documentUrl?: string;
  note?: string;
  actorId?: number;
}) {
  return runTx(async (tx) => {
    const shipment = await tx.shipment.findUnique({ where: { id: input.shipmentId } });
    if (!shipment) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${input.shipmentId} does not exist.`, 404);
    const clearance = await tx.regulatoryClearance.findFirst({ where: { shipmentId: shipment.id, board: input.board as never } });
    if (!clearance) throw new DomainError('CLEARANCE_NOT_FOUND', `No ${input.board} clearance is open on this shipment.`, 404);

    const target = ACTION_RESULT[input.action];
    if (!ALLOWED_FROM[input.action].includes(clearance.status)) {
      throw new DomainError('INVALID_CLEARANCE_STATE', `${input.action} is not allowed from ${clearance.status}.`, 409, { status: clearance.status });
    }
    if (input.action === 'APPROVE' && !input.referenceNo && !clearance.referenceNo) {
      throw new DomainError('REFERENCE_REQUIRED', 'Approval needs the board\'s clearance reference number.', 422);
    }
    if (input.action === 'REJECT' && !input.note) throw new DomainError('NOTE_REQUIRED', 'Say why the clearance was rejected.', 422);

    const now = new Date();
    await tx.regulatoryClearance.update({
      where: { id: clearance.id },
      data: {
        status: target.status as never,
        ...(input.applicationNo ? { applicationNo: input.applicationNo } : {}),
        ...(input.referenceNo ? { referenceNo: input.referenceNo } : {}),
        ...(input.validTill ? { validTill: input.validTill } : {}),
        ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
        ...(input.note ? { officerNote: input.note } : {}),
        ...(input.action === 'SUBMIT' ? { submittedAt: now } : {}),
        ...(input.action === 'APPROVE' ? { approvedAt: now } : {}),
      },
    });
    await tx.complianceEvent.create({
      data: {
        shipmentId: shipment.id,
        clearanceId: clearance.id,
        board: clearance.board,
        type: target.event as never,
        message: input.note ?? null,
        actorId: input.actorId ?? null,
      },
    });

    // Roll the shipment's PGA state up from every clearance it has.
    const all = await tx.regulatoryClearance.findMany({ where: { shipmentId: shipment.id } });
    const statuses = all.map((c) => c.status);
    const rollup = statuses.some((s) => s === 'REJECTED' || s === 'EXPIRED')
      ? 'REJECTED'
      : statuses.every((s) => s === 'NOT_REQUIRED')
        ? 'NOT_REQUIRED'
        : statuses.every((s) => s === 'APPROVED' || s === 'NOT_REQUIRED')
          ? 'APPROVED'
          : 'PENDING';
    await tx.shipment.update({ where: { id: shipment.id }, data: { pgaClearance: rollup as never } });

    const hold = await tx.customsHold.findFirst({ where: { shipmentId: shipment.id, status: { in: ['ACTIVE', 'ESCALATED'] } }, orderBy: { id: 'desc' } });
    if (hold) {
      if (rollup === 'REJECTED' && hold.status !== 'ESCALATED') await tx.customsHold.update({ where: { id: hold.id }, data: { status: 'ESCALATED' } });
      if ((rollup === 'APPROVED' || rollup === 'NOT_REQUIRED') && hold.reason === 'PGA_PENDING') {
        await tx.customsHold.update({ where: { id: hold.id }, data: { reason: 'ASSESSMENT_PENDING', status: 'ACTIVE' } });
      }
    }
    if (rollup === 'APPROVED') {
      await recordMilestone(tx, { shipmentId: shipment.id, milestone: 'PGA_CLEARED', at: now, actorId: input.actorId, batches: 'all' });
    }

    let step: string | null = null;
    if (shipment.direction === 'IMPORT') {
      step = rollup === 'REJECTED' ? 'BLOCKED' : rollup === 'PENDING' ? 'IN_PROGRESS' : 'DONE';
      await recordStep(tx, { shipmentId: shipment.id }, 'PGA_CLEARANCES', step as never, { actorId: input.actorId, reopen: true });
    }
    await writeAudit(tx, { entity: 'RegulatoryClearance', entityId: clearance.id, action: 'STATUS_CHANGE', actorId: input.actorId, before: { status: clearance.status }, after: { status: target.status } });
    return { clearanceId: clearance.id, board: clearance.board, status: target.status, pgaClearance: rollup, step };
  });
}
