import { defineAction } from '@/lib/http';
import { confirmDelivery } from '@/modules/logistics/services/delivery.service';
import { Delivery } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'logistics:write',
  schema: Delivery,
  run: ({ id, ...rest }, actor) => confirmDelivery({ shipmentId: id, ...rest, actorId: actor.id }),
});
