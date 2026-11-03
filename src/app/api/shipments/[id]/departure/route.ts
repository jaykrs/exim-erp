import { defineAction } from '@/lib/http';
import { confirmDeparture } from '@/modules/customs/services';
import { Departure } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'logistics:write',
  schema: Departure,
  run: ({ id, ...rest }, actor) => confirmDeparture({ shipmentId: id, ...rest, actorId: actor.id }),
});
