import { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { requireActor, type Actor } from './auth';
import { DomainError } from './errors';
import type { Permission } from './rbac';

type RouteCtx = { params: Promise<Record<string, string>> };

const fail = (status: number, code: string, message: string, details?: unknown) =>
  NextResponse.json({ error: { code, message, details } }, { status });

/** Single place where thrown errors become HTTP responses. */
export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof DomainError) return fail(e.httpStatus, e.code, e.message, e.details);
  if (e instanceof ZodError) return fail(422, 'VALIDATION_FAILED', 'Invalid request.', e.flatten());
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2003') return fail(422, 'INVALID_REFERENCE', 'A referenced record does not exist.');
    if (e.code === 'P2002') return fail(409, 'DUPLICATE', 'A conflicting record already exists.');
    if (e.code === 'P2025') return fail(404, 'NOT_FOUND', 'Record not found.');
  }
  console.error('[unhandled]', e);
  return fail(500, 'INTERNAL', 'Unexpected error.');
}

/**
 * Build a POST handler: authenticate + authorise → validate (URL params merged over the JSON body, so a
 * body can never override an id in the path) → run the service → JSON.
 */
export function defineAction<S extends ZodTypeAny>(opts: {
  permission: Permission;
  schema: S;
  run: (input: z.infer<S>, actor: Actor) => Promise<unknown>;
  status?: number;
}) {
  return async function POST(req: NextRequest, ctx: RouteCtx) {
    try {
      const actor = await requireActor(req, opts.permission);
      const params = ctx?.params ? await ctx.params : {};
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const input = opts.schema.parse({ ...(body && typeof body === 'object' ? body : {}), ...params });
      const result = await opts.run(input, actor);
      return NextResponse.json(result ?? { ok: true }, { status: opts.status ?? 200 });
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

/** GET handler: needs the `read` permission; params + query string are validated together. */
export function defineQuery<S extends ZodTypeAny>(opts: {
  schema: S;
  run: (input: z.infer<S>, actor: Actor) => Promise<unknown>;
}) {
  return async function GET(req: NextRequest, ctx: RouteCtx) {
    try {
      const actor = await requireActor(req, 'read');
      const params = ctx?.params ? await ctx.params : {};
      const query = Object.fromEntries(new URL(req.url).searchParams);
      const result = await opts.run(opts.schema.parse({ ...query, ...params }), actor);
      return NextResponse.json(result);
    } catch (e) {
      return toErrorResponse(e);
    }
  };
}

export const dynamic = 'force-dynamic';
