import { defineAction } from '@/lib/http';
import { generateTraceTags } from '@/modules/warehouse/services';
import { TraceTags } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'warehouse:write',
  schema: TraceTags,
  status: 201,
  run: (input, actor) => generateTraceTags({ ...input, actorId: actor.id }),
});
