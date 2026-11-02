/**
 * Persistence + read-model for the consignment workflow (see workflow.ts).
 *   recordStep()            — write one step transition inside a caller's transaction
 *   getConsignmentTimeline() — the 6-stage checklist for a shipment, with batch/PO/vendor
 *                              steps rolled up across everything the shipment contains
 */
import type { Prisma } from '@prisma/client';
import { DomainError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import {
  SCOPE_KEY,
  STAGES,
  STEPS,
  STEPS_BY_CODE,
  aggregateStatus,
  stepsInStage,
  unmetPrerequisites,
  type StepScope,
  type StepStatus,
  type WorkflowStepCode,
} from './workflow';

type Tx = Prisma.TransactionClient;

export type StepSubject =
  | { vendorId: number }
  | { purchaseOrderId: number }
  | { batchId: number }
  | { shipmentId: number };

export interface RecordStepOptions {
  actorId?: number;
  evidenceUrl?: string;
  note?: string;
  /** Allow moving a DONE step back to a non-DONE status (default: automated callers never regress DONE). */
  reopen?: boolean;
}

/**
 * Upsert a step for a subject. Marking DONE enforces same-scope prerequisites (409 otherwise).
 * Returns `changed: false` when an automated update was ignored because the step is already DONE.
 */
export async function recordStep(
  tx: Tx,
  subject: StepSubject,
  code: WorkflowStepCode,
  status: StepStatus,
  opts: RecordStepOptions = {},
): Promise<{ id: number; changed: boolean }> {
  const def = STEPS_BY_CODE[code];
  const key = Object.keys(subject)[0];
  if (SCOPE_KEY[def.scope] !== key) {
    throw new DomainError('STEP_SCOPE_MISMATCH', `${code} is tracked per ${def.scope}, not per ${key}.`, 422);
  }

  if (status === 'DONE' && def.dependsOn.length > 0) {
    const prior = await tx.consignmentStep.findMany({
      where: { ...subject, stepCode: { in: def.dependsOn } },
      select: { stepCode: true, status: true },
    });
    const current: Partial<Record<WorkflowStepCode, StepStatus>> = {};
    for (const p of prior) current[p.stepCode] = p.status;
    const unmet = unmetPrerequisites(code, current);
    if (unmet.length > 0) {
      throw new DomainError('STEP_PREREQUISITE_PENDING', `${code} cannot be completed before: ${unmet.join(', ')}.`, 409, { unmet });
    }
  }

  const existing = await tx.consignmentStep.findFirst({
    where: { ...subject, stepCode: code },
    select: { id: true, status: true },
  });
  if (existing?.status === 'DONE' && status !== 'DONE' && !opts.reopen) {
    return { id: existing.id, changed: false };
  }

  const done = status === 'DONE';
  const data = {
    status,
    stage: def.stage,
    completedAt: done ? new Date() : null,
    completedById: done ? (opts.actorId ?? null) : null,
    ...(opts.evidenceUrl !== undefined ? { evidenceUrl: opts.evidenceUrl } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };

  if (existing) {
    await tx.consignmentStep.update({ where: { id: existing.id }, data });
    return { id: existing.id, changed: true };
  }
  const created = await tx.consignmentStep.create({ data: { ...subject, stepCode: code, ...data } });
  return { id: created.id, changed: true };
}

export interface TimelineStep {
  code: WorkflowStepCode;
  title: string;
  scope: StepScope;
  erpDataState: string;
  status: StepStatus;
  /** Subjects (vendors / POs / batches / the shipment) that have completed this step vs. that it applies to. */
  progress: { done: number; total: number };
  applicable: boolean;
  completedAt: Date | null;
  evidenceUrl: string | null;
}

/** The checklist as a consignment-level timeline: one entry per step, grouped by stage. */
export async function getConsignmentTimeline(shipmentId: number) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      shipmentNo: true,
      direction: true,
      status: true,
      currentMilestone: true,
      currentMilestoneAt: true,
      currentLocationText: true,
      items: {
        select: {
          batchId: true,
          batch: {
            select: {
              vendorId: true,
              inwardLine: { select: { inwardReceipt: { select: { purchaseOrderId: true } } } },
            },
          },
        },
      },
    },
  });
  if (!shipment) throw new DomainError('SHIPMENT_NOT_FOUND', `Shipment ${shipmentId} does not exist.`, 404);

  const batchIds = [...new Set(shipment.items.map((i) => i.batchId))];
  const vendorIds = [...new Set(shipment.items.map((i) => i.batch.vendorId))];
  const poIds = [
    ...new Set(
      shipment.items
        .map((i) => i.batch.inwardLine?.inwardReceipt.purchaseOrderId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];

  const rows = await prisma.consignmentStep.findMany({
    where: {
      OR: [
        { shipmentId },
        { batchId: { in: batchIds } },
        { vendorId: { in: vendorIds } },
        { purchaseOrderId: { in: poIds } },
      ],
    },
    select: {
      stepCode: true,
      status: true,
      completedAt: true,
      evidenceUrl: true,
      shipmentId: true,
      batchId: true,
      vendorId: true,
      purchaseOrderId: true,
    },
  });

  const subjects: Record<StepScope, number[]> = {
    SHIPMENT: [shipmentId],
    BATCH: batchIds,
    VENDOR: vendorIds,
    PURCHASE_ORDER: poIds,
  };

  const stages = STAGES.map((stage) => ({
    stage: stage.stage,
    title: stage.title,
    objective: stage.objective,
    steps: stepsInStage(stage.stage).map((def): TimelineStep => {
      const col = SCOPE_KEY[def.scope];
      const ids = subjects[def.scope];
      const byId = new Map(rows.filter((r) => r.stepCode === def.code).map((r) => [r[col], r] as const));
      const statuses = ids.map((id): StepStatus => byId.get(id)?.status ?? 'PENDING');
      const single = def.scope === 'SHIPMENT' ? byId.get(shipmentId) : undefined;
      return {
        code: def.code,
        title: def.title,
        scope: def.scope,
        erpDataState: def.erpDataState,
        status: aggregateStatus(statuses),
        progress: { done: statuses.filter((s) => s === 'DONE').length, total: ids.length },
        applicable: ids.length > 0,
        completedAt: single?.completedAt ?? null,
        evidenceUrl: single?.evidenceUrl ?? null,
      };
    }),
  }));

  const applicable = stages.flatMap((s) => s.steps).filter((s) => s.applicable && s.status !== 'SKIPPED');
  return {
    shipment: {
      id: shipment.id,
      shipmentNo: shipment.shipmentNo,
      direction: shipment.direction,
      status: shipment.status,
      currentMilestone: shipment.currentMilestone,
      since: shipment.currentMilestoneAt,
      locationText: shipment.currentLocationText,
    },
    overall: { done: applicable.filter((s) => s.status === 'DONE').length, total: applicable.length, stepCount: STEPS.length },
    stages,
  };
}
