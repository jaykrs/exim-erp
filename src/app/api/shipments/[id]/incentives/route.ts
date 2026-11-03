import { defineAction } from '@/lib/http';
import { logZeroRatedAndIncentives } from '@/modules/customs/services';
import { Incentives } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'finance:write',
  schema: Incentives,
  status: 201,
  run: ({ id, ...rest }, actor) => logZeroRatedAndIncentives({ shipmentId: id, ...rest, actorId: actor.id }),
});
