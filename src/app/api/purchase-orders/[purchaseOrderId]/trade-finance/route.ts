import { defineAction } from '@/lib/http';
import { activateTradeFinance } from '@/modules/sourcing/services';
import { TradeFinance } from '@/modules/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineAction({
  permission: 'trade-finance:write',
  schema: TradeFinance,
  status: 201,
  run: (input, actor) => activateTradeFinance({ ...input, actorId: actor.id }),
});
