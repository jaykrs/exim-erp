import { defineAction } from '@/lib/http';
import { fileManifest } from '@/modules/customs/services';
import { Manifest } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'customs:write',
  schema: Manifest,
  status: 201,
  run: ({ id, ...rest }, actor) => fileManifest({ shipmentId: id, ...rest, actorId: actor.id }),
});
