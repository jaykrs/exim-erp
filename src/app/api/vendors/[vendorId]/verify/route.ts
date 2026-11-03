import { defineAction } from '@/lib/http';
import { verifyVendor } from '@/modules/sourcing/services';
import { VerifyVendor } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'sourcing:write',
  schema: VerifyVendor,
  run: (input, actor) => verifyVendor({ ...input, actorId: actor.id }),
});
