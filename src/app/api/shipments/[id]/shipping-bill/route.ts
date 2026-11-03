import { defineAction } from '@/lib/http';
import { fileShippingBill } from '@/modules/customs/services';
import { ShippingBill } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'customs:write',
  schema: ShippingBill,
  status: 201,
  run: ({ id, ...rest }, actor) => fileShippingBill({ shipmentId: id, ...rest, actorId: actor.id }),
});
