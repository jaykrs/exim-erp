import { defineAction } from '@/lib/http';
import { executeIncotermPi } from '@/modules/sourcing/services';
import { ExecutePi } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'sourcing:write',
  schema: ExecutePi,
  run: (input, actor) => executeIncotermPi({ ...input, actorId: actor.id }),
});
