import { defineAction } from '@/lib/http';
import { bookForwardContract } from '@/modules/sourcing/services';
import { ForwardContract } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'trade-finance:write',
  schema: ForwardContract,
  status: 201,
  run: (input, actor) => bookForwardContract({ ...input, actorId: actor.id }),
});
