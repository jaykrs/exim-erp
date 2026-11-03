import { defineAction } from '@/lib/http';
import { reconcileShipment } from '@/modules/finance/services';
import { Reconcile } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'finance:write',
  schema: Reconcile,
  run: ({ id, ...rest }, actor) => reconcileShipment({ shipmentId: id, ...rest, actorId: actor.id }),
});
