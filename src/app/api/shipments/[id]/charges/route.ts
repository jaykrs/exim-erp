import { defineAction } from '@/lib/http';
import { postShipmentCharge } from '@/modules/finance/services';
import { Charge } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'finance:write',
  schema: Charge,
  status: 201,
  run: ({ id, ...rest }, actor) => postShipmentCharge({ shipmentId: id, ...rest, actorId: actor.id }),
});
