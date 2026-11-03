import { z } from 'zod';

/** Positive integer id (also accepts numeric strings from URL params). */
export const id = z.coerce.number().int().positive();
/** Non-negative decimal as a string; numbers are accepted and stringified (never used for arithmetic here). */
export const dec = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+(\.\d+)?$/.test(v), 'Expected a non-negative decimal number');
export const date = z.coerce.date();
export const text = (max = 200) => z.string().trim().min(1).max(max);
export const url = z.string().url().max(500);
