/**
 * Migration 0305 — the durable "end this member's coverage" request stamped
 * on a member's OPEN renewal cycle (`renewal_cycles.end_coverage_*`).
 *
 * Written by `endMembershipCoverageNow` when coverage must NOT end yet:
 *   - refund-backed (`refundId` + `invoiceId` set): an async F5 refund is still
 *     settling. Coverage ends only once it settles `succeeded`; a `failed`
 *     settle returned no money, so the request is cleared and the member keeps
 *     coverage.
 *   - plain (`refundId` null): the inline end failed after the credit note /
 *     refund had committed; the nightly pass retries it.
 * Converged by `reconcileMembershipCoverageEnds`.
 *
 * A separate port (not new `RenewalCycle` fields) so the aggregate every
 * fixture constructs is unchanged; the columns ride on the cycle row, so they
 * inherit its RLS. Writes are GUARDED on a non-terminal status — a request is
 * only ever pending on an open cycle, and a request left on a terminal row is
 * forensic only (the reconcile lists non-terminal rows).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { CycleId } from '../../domain/renewal-cycle';
import type { TenantTx } from '@/lib/db';

export interface MembershipCoverageEndRequest {
  readonly cycleId: CycleId;
  readonly memberId: string;
  readonly requestedAt: string;
  /** F5 refund id (`rfnd_…`) this request waits on; null for a plain retry. */
  readonly refundId: string | null;
  /** The refunded invoice — the key the F5 settlement lookup reads by. */
  readonly invoiceId: string | null;
  readonly actorUserId: string | null;
}

export interface MembershipCoverageEndRepo {
  /**
   * Stamp the request on an OPEN cycle. GUARDED `WHERE status NOT IN
   * (terminal)` — `false` when 0 rows matched (the cycle closed in the race
   * window). Overwrites an earlier request on the same cycle: the latest
   * staff decision is the one to converge. Thread `tx` from `runInTenant`.
   */
  stampInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    request: {
      readonly requestedAt: string;
      readonly refundId: string | null;
      readonly invoiceId: string | null;
      readonly actorUserId: string | null;
    },
  ): Promise<boolean>;

  /**
   * Clear the request — a refund-backed one whose refund settled `failed`.
   * CAS on `expectedRefundId` so a newer request stamped in the read→clear
   * window is never wiped. `false` when 0 rows matched.
   */
  clearInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    expectedRefundId: string | null,
  ): Promise<boolean>;

  /** Pending requests on OPEN cycles, oldest first. Tenant-scoped (RLS). */
  listPending(
    tenantId: string,
    limit: number,
  ): Promise<readonly MembershipCoverageEndRequest[]>;
}
