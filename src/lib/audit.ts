import type { Prisma } from '@prisma/client';
import type { Tx } from './tx';

type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE';

/** Append one row to the audit log inside the caller's transaction. `before` / `after` must be JSON-safe. */
export async function writeAudit(
  tx: Tx,
  e: { entity: string; entityId: number | string; action: AuditAction; actorId?: number; before?: unknown; after?: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entity: e.entity,
      entityId: String(e.entityId),
      action: e.action,
      actorId: e.actorId ?? null,
      before: e.before === undefined ? undefined : (JSON.parse(JSON.stringify(e.before)) as Prisma.InputJsonValue),
      after: e.after === undefined ? undefined : (JSON.parse(JSON.stringify(e.after)) as Prisma.InputJsonValue),
    },
  });
}
