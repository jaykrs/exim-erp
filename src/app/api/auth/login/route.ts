import { NextResponse, type NextRequest } from 'next/server';
import { toErrorResponse } from '@/lib/http';
import { DomainError } from '@/lib/errors';
import { verifyPassword } from '@/lib/password';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from '@/lib/session';
import { Login } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A throwaway hash so a missing user costs the same time as a wrong password.
const DUMMY = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function POST(req: NextRequest) {
  try {
    const { email, password } = Login.parse(await req.json().catch(() => ({})));
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const ok = verifyPassword(password, user?.passwordHash ?? DUMMY);
    if (!user || !user.isActive || !ok) throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);

    const token = await signSession({ uid: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
    const res = NextResponse.json({ user: { id: user.id, name: user.name, role: user.role } });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } catch (e) {
    return toErrorResponse(e);
  }
}
