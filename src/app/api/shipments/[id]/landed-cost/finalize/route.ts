import { defineAction } from '@/lib/http';
import { finalizeLandedCost } from '@/modules/finance/services';
import { FinalizeCost } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'finance:write',
  schema: FinalizeCost,
  run: ({ id, ...rest }, actor) => finalizeLandedCost({ shipmentId: id, ...rest, actorId: actor.id }),
});
