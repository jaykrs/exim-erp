import { DomainError } from './errors';
import { can, isRole, type Permission, type Role } from './rbac';
import { readCookie, SESSION_COOKIE, verifySession } from './session';

export interface Actor {
  id: number;
  role: Role;
}

/**
 * Resolves who is calling. Order: signed session cookie → `Authorization: Bearer <session token>` →
 * (development only) `x-user-id` + `x-user-role` headers so endpoints can be exercised with curl.
 * FAILS CLOSED: anything else is a 401.
 */
export async function getActor(req: Request): Promise<Actor> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE) ?? bearer;
  const session = await verifySession(token);
  if (session && isRole(session.role)) return { id: session.uid, role: session.role };

  if (process.env.NODE_ENV === 'development') {
    const id = Number(req.headers.get('x-user-id'));
    const role = req.headers.get('x-user-role') ?? '';
    if (Number.isInteger(id) && id > 0 && isRole(role)) return { id, role };
  }
  throw new DomainError('UNAUTHENTICATED', 'Sign in to continue.', 401);
}

/** 401 if not signed in, 403 if the role lacks the permission. */
export async function requireActor(req: Request, permission: Permission): Promise<Actor> {
  const actor = await getActor(req);
  if (!can(actor.role, permission)) {
    throw new DomainError('FORBIDDEN', `Role ${actor.role} may not perform this action (${permission}).`, 403);
  }
  return actor;
}

/** Back-compat helper for handlers that only need the user id. */
export async function getActorId(req: Request): Promise<number> {
  return (await getActor(req)).id;
}
