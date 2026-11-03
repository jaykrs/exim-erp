import { defineAction } from '@/lib/http';
import { gradeBatch } from '@/modules/warehouse/services';
import { GradeBatch } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'warehouse:write',
  schema: GradeBatch,
  run: (input, actor) => gradeBatch({ ...input, actorId: actor.id }),
});
