import { Decimal } from '@prisma/client/runtime/library';

/**
 * All money math goes through Decimal (never JS numbers). Rounding rules live here so that
 * switching to a different customs/ICEGATE rounding convention is a one-line change.
 */
export { Decimal };

export const D = (v: Decimal.Value): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

export const sum = (xs: Decimal[]): Decimal => xs.reduce((a, b) => a.plus(b), ZERO);

/** Currency amounts (2 dp, half-up). */
export const round2 = (v: Decimal): Decimal => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Unit costs / unit prices (4 dp, half-up). */
export const round4 = (v: Decimal): Decimal => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

/**
 * Split `total` across `weights` so the parts are exact 2-dp amounts that sum EXACTLY to
 * round2(total) (largest-remainder method). Zero/empty weight vectors fall back to an equal split.
 */
export function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  const n = weights.length;
  if (n === 0) return [];

  const t = round2(total);
  const negative = t.isNegative();
  const abs = t.abs();

  let w = weights.map((x) => x.abs());
  if (sum(w).isZero()) w = weights.map(() => D(1));
  const sumW = sum(w);

  const raw = w.map((x) => abs.times(x).div(sumW));
  const floors = raw.map((r) => r.toDecimalPlaces(2, Decimal.ROUND_DOWN));
  const centsLeft = abs.minus(sum(floors)).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

  const order = raw
    .map((r, i) => ({ i, frac: r.minus(floors[i]) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);

  const out = floors.slice();
  for (let k = 0; k < centsLeft; k++) {
    const idx = order[k % n].i;
    out[idx] = out[idx].plus('0.01');
  }
  return negative ? out.map((x) => x.neg()) : out;
}
