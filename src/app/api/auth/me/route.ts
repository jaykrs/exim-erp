import { z } from 'zod';
import { defineQuery } from '@/lib/http';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineQuery({
  schema: z.object({}).passthrough(),
  run: async (_input, actor) => {
    const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { id: true, name: true, email: true, role: true } });
    return { user };
  },
});
