import { defineAction } from '@/lib/http';
import { confirmLoading } from '@/modules/customs/services';
import { Loading } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'logistics:write',
  schema: Loading,
  run: ({ id, ...rest }, actor) => confirmLoading({ shipmentId: id, ...rest, actorId: actor.id }),
});
