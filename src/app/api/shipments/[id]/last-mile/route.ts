import { defineAction } from '@/lib/http';
import { startLastMile } from '@/modules/logistics/services/delivery.service';
import { LastMile } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'logistics:write',
  schema: LastMile,
  run: ({ id, ...rest }, actor) => startLastMile({ shipmentId: id, ...rest, actorId: actor.id }),
});
