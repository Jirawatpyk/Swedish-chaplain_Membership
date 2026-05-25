/**
 * F9 broadcast source adapter (US1 / AS-2) — counts broadcasts awaiting admin
 * approval via the broadcasts PUBLIC BARREL (`makeBroadcastApprovalCounter`),
 * no deep imports (Constitution Principle III). Backs the dashboard
 * "needs attention" broadcasts count.
 */
import { makeBroadcastApprovalCounter } from '@/modules/broadcasts';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastConsumptionSource } from '../../application/ports/source-ports';

export const broadcastSourceAdapter: Pick<
  BroadcastConsumptionSource,
  'countAwaitingApproval'
> = {
  async countAwaitingApproval(ctx: TenantContext): Promise<number> {
    return makeBroadcastApprovalCounter(ctx.slug).countAwaitingApproval(ctx);
  },
};
