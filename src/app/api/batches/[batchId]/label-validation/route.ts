import { defineAction } from '@/lib/http';
import { validateLabel } from '@/modules/compliance/services';
import { LabelValidation } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'compliance:write',
  schema: LabelValidation,
  status: 201,
  run: (input, actor) => validateLabel({ ...input, actorId: actor.id }),
});
