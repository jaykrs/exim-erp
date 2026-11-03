import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export type Tx = Prisma.TransactionClient;

/**
 * Run `fn` in one interactive transaction (ReadCommitted). Retries on write conflicts / deadlocks (P2034)
 * up to `maxAttempts`. `fn` must be safe to re-run: do all reads inside it.
 */
export async function runTx<T>(fn: (tx: Tx) => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction((tx) => fn(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5_000,
        timeout: 20_000,
      });
    } catch (e) {
      const retryable = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034';
      if (!retryable || attempt >= maxAttempts) throw e;
    }
  }
}
