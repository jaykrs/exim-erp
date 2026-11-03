import { defineAction } from '@/lib/http';
import { recordLabTest } from '@/modules/compliance/services';
import { LabTest } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'compliance:write',
  schema: LabTest,
  status: 201,
  run: (input, actor) => recordLabTest({ ...input, actorId: actor.id }),
});
