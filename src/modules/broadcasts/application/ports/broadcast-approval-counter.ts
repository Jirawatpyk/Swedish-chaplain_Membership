/**
 * `BroadcastApprovalCounter` port — counts broadcasts awaiting admin approval
 * (status `submitted`) for the current tenant. Backs the F9 dashboard
 * "needs attention" broadcasts count (FR-002 / AS-2). Kept separate from the
 * broad `BroadcastsRepo` so adding it doesn't force every existing repo mock
 * to grow a method.
 */
import type { TenantContext } from '@/modules/tenants';

export interface BroadcastApprovalCounter {
  countAwaitingApproval(ctx: TenantContext): Promise<number>;
}
