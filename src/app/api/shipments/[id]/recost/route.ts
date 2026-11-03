import { defineAction } from '@/lib/http';
import { recostLandedCost } from '@/modules/finance/services';
import { Recost } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'finance:write',
  schema: Recost,
  run: ({ id, ...rest }, actor) => recostLandedCost({ shipmentId: id, ...rest, actorId: actor.id }),
});
