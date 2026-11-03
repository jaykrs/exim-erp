import { defineAction } from '@/lib/http';
import { grantOoc } from '@/modules/customs/services';
import { Ooc } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'customs:write',
  schema: Ooc,
  run: ({ id, ...rest }, actor) => grantOoc({ shipmentId: id, ...rest, actorId: actor.id }),
});
