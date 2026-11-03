import { defineAction } from '@/lib/http';
import { submitBillOfEntry } from '@/modules/customs/services';
import { BillOfEntry } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'customs:write',
  schema: BillOfEntry,
  status: 201,
  run: ({ id, ...rest }, actor) => submitBillOfEntry({ shipmentId: id, ...rest, actorId: actor.id }),
});
