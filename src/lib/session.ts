/**
 * Signed session cookie using Web Crypto (HMAC-SHA256) so the same code runs in Node route handlers
 * AND in Edge middleware. Token = base64url(payload) + "." + base64url(signature).
 */
export const SESSION_COOKIE = 'exim_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionPayload {
  uid: number;
  role: string;
  exp: number; // unix seconds
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be set to at least 32 characters.');
  return s;
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** Returns the payload for a valid, unexpired token; null otherwise (never throws on bad input). */
export async function verifySession(token: string | undefined | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Partial<SessionPayload>;
    if (typeof p.uid !== 'number' || typeof p.role !== 'string' || typeof p.exp !== 'number') return null;
    return p.exp > nowSeconds ? (p as SessionPayload) : null;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
