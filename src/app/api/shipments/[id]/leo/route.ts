import { defineAction } from '@/lib/http';
import { grantLeo } from '@/modules/customs/services';
import { Leo } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'customs:write',
  schema: Leo,
  run: ({ id, ...rest }, actor) => grantLeo({ shipmentId: id, ...rest, actorId: actor.id }),
});
