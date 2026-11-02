import { DomainError } from './errors';

/**
 * PLACEHOLDER — wire this to your real session layer (Auth.js / NextAuth, SSO, etc.).
 *
 * It FAILS CLOSED: outside local development every call is rejected with 401, so no write
 * endpoint is reachable unauthenticated until this is implemented. In development it trusts an
 * `x-user-id` header purely so the endpoints can be exercised with curl.
 */
export async function getActorId(req: Request): Promise<number> {
  if (process.env.NODE_ENV !== 'production') {
    const raw = req.headers.get('x-user-id');
    const id = raw ? Number(raw) : NaN;
    if (Number.isInteger(id) && id > 0) return id;
    throw new DomainError('UNAUTHENTICATED', 'Send an x-user-id header (development only).', 401);
  }
  throw new DomainError('UNAUTHENTICATED', 'Authentication is not configured.', 401);
}
