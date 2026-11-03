import { defineAction } from '@/lib/http';
import { resolveClearance } from '@/modules/compliance/services';
import { ResolveClearance } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'compliance:write',
  schema: ResolveClearance,
  run: ({ id, ...rest }, actor) => resolveClearance({ shipmentId: id, ...rest, actorId: actor.id }),
});
