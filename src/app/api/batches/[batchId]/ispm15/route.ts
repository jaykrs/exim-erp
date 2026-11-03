import { defineAction } from '@/lib/http';
import { verifyIspm15 } from '@/modules/compliance/services';
import { Ispm15 } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'compliance:write',
  schema: Ispm15,
  status: 201,
  run: (input, actor) => verifyIspm15({ ...input, actorId: actor.id }),
});
