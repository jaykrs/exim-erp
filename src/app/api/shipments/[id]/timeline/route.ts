import { z } from 'zod';
import { defineQuery } from '@/lib/http';
import { id } from '@/lib/zod-helpers';
import { getConsignmentTimeline } from '@/modules/consignment/step-tracker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineQuery({
  schema: z.object({ id }).passthrough(),
  run: ({ id: shipmentId }) => getConsignmentTimeline(shipmentId),
});
