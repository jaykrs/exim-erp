import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getActorId } from '@/lib/auth';
import { DomainError } from '@/lib/errors';
import { processPortArrival } from '@/modules/logistics/services/port-arrival.service';

export const runtime = 'nodejs'; // Prisma needs the Node runtime, not Edge
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    arrivedAt: z.coerce.date(),
    terminalLocationId: z.number().int().positive().optional(),
    locationText: z.string().max(200).optional(),
    temperatureC: z.number().min(-90).max(60).optional(),
    igstRecoverable: z.boolean().optional(),
    containers: z
      .array(
        z.object({
          containerNo: z.string().regex(/^[A-Z]{4}\d{7}$/, 'ISO 6346 container number expected (e.g. MSKU1234567)'),
          yardSlot: z.string().max(40).optional(),
          stackingType: z
            .enum(['STANDARD', 'REEFER_PLUGGED', 'HAZARDOUS', 'OVER_DIMENSIONAL', 'EMPTY_STACK'])
            .optional(),
        }),
      )
      .max(200)
      .optional(),
  })
  .strict();

const fail = (status: number, code: string, message: string, details?: unknown) =>
  NextResponse.json({ error: { code, message, details } }, { status });

/**
 * POST /api/shipments/:id/port-arrival
 * Processes arrival at the port: landed cost → compliance triggers → CUSTOMS_HOLD, atomically.
 * 201 = processed now · 200 = already processed (idempotent replay).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actorId = await getActorId(req);

    const { id } = await ctx.params;
    const shipmentId = Number(id);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) return fail(400, 'BAD_ID', 'Shipment id must be a positive integer.');

    const json = await req.json().catch(() => null);
    const parsed = Body.safeParse(json);
    if (!parsed.success) return fail(422, 'VALIDATION_FAILED', 'Invalid request body.', parsed.error.flatten());

    const result = await processPortArrival({ shipmentId, actorId, ...parsed.data });
    return NextResponse.json(result, { status: result.alreadyProcessed ? 200 : 201 });
  } catch (e) {
    if (e instanceof DomainError) return fail(e.httpStatus, e.code, e.message, e.details);
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2003') return fail(422, 'INVALID_REFERENCE', 'A referenced record does not exist.');
      if (e.code === 'P2002') return fail(409, 'DUPLICATE', 'A conflicting record already exists; retry.');
    }
    console.error('[port-arrival] unexpected error', e);
    return fail(500, 'INTERNAL_ERROR', 'Unexpected error.');
  }
}
