/**
 * Migration 0306 — the durable "end this member's coverage" request stamped
 * on a member's OPEN renewal cycle (`renewal_cycles.end_coverage_*`).
 *
 * Written by `endMembershipCoverageNow` when coverage must NOT end yet:
 *   - refund-backed (`refundId` + `invoiceId` set): an async F5 refund is still
 *     settling. Coverage ends only once it settles `succeeded`; a `failed`
 *     settle returned no money, so the request is cleared and the member keeps
 *     coverage.
 *   - plain (`refundId` null): the inline end failed after the credit note /
 *     refund had committed; the hourly pass retries it.
 * Converged by `reconcileMembershipCoverageEnds`.
 *
 * A separate port (not new `RenewalCycle` fields) so the aggregate every
 * fixture constructs is unchanged; the columns ride on the cycle row, so they
 * inherit its RLS (plus an explicit tenant predicate). A request is only ever
 * pending on an OPEN cycle; one left on a cycle that closed some other way is
 * cleared by the reconcile (`clearStranded`), so it can never be revived.
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
   * Stamp the request on an OPEN cycle (upcoming | reminded |
   * awaiting_payment). `false` when 0 rows matched: the cycle left the open
   * states in the race window, or a refund-backed request met an existing
   * PLAIN one (which ends coverage sooner and is never overwritten). Thread
   * `tx` from `runInTenant`.
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
      /** Backstop: stamp only when the cycle carries no request yet. */
      readonly onlyIfAbsent?: boolean;
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

  /**
   * Clear requests stranded on cycles that left the OPEN states (other than
   * the resulting `cancelled`/`coverage_ended` row, kept for forensics).
   * Returns the cleared cycle ids. Tenant-scoped (RLS + explicit predicate).
   */
  clearStranded(tenantId: string): Promise<readonly CycleId[]>;

  /** Pending requests on OPEN cycles, oldest first. Tenant-scoped (RLS). */
  listPending(
    tenantId: string,
    limit: number,
  ): Promise<readonly MembershipCoverageEndRequest[]>;
}
