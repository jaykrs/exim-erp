import { defineAction } from '@/lib/http';
import { recordInwardInspection } from '@/modules/warehouse/services';
import { InwardReceipt } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'warehouse:write',
  schema: InwardReceipt,
  status: 201,
  run: (input, actor) => recordInwardInspection({ ...input, actorId: actor.id }),
});
