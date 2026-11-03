import { z } from 'zod';
import { defineQuery } from '@/lib/http';
import { getBatchPosition } from '@/modules/logistics/queries/batch-position';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineQuery({
  schema: z.object({ batchNo: z.string().min(1).max(50), trail: z.coerce.number().int().min(1).max(500).optional() }).passthrough(),
  run: ({ batchNo, trail }) => getBatchPosition(batchNo, trail),
});
