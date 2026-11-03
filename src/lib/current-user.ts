import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/session';
import { prisma } from '@/lib/prisma';

/** The signed-in user for server components (middleware has already redirected anonymous visitors). */
export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await verifySession(token);
  if (!s) return null;
  return prisma.user.findUnique({ where: { id: s.uid }, select: { id: true, name: true, role: true } });
}
