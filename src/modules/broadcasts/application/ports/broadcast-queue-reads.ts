/**
 * F119 T116 / T119 — the two aggregate reads the staff E-Blast dashboard
 * (`/admin/broadcasts`) needs beside its page of rows (contracts/
 * dashboard-and-notifications.md § 1.1, § 1.2).
 *
 * Kept apart from the broad `BroadcastsRepo` for the reason
 * `BroadcastApprovalCounter` is: a required method there fails the ~20
 * structural repo doubles in the test suite.
 *
 * Counts and delivery totals only — never a recipient address or any other
 * contact-level field (FR-036). "Who receives it and their opt-in state" is
 * the 108 Marketing audience page's job.
 */
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';

/** The FR-029 delivery results of one sent E-Blast, from the `broadcast_deliveries` aggregate. */
export interface DeliveryResult {
  /** Every delivery event recorded for the E-Blast — the portal detail's "total". */
  readonly recipients: number;
  readonly delivered: number;
  /** Hard and soft bounces together. */
  readonly bounced: number;
  readonly complained: number;
}

export interface BroadcastQueueReads {
  /** Rows per status for the tenant, zero-filled over EVERY status (FR-025). */
  countByStatus(ctx: TenantContext): Promise<Readonly<Record<BroadcastStatus, number>>>;
  /**
   * The delivery results of the given E-Blasts in ONE grouped read (a page can
   * hold 50 sent rows; one read each would be N+1). An id with no delivery
   * event is absent from the map.
   */
  deliveryCountsFor(
    ctx: TenantContext,
    broadcastIds: readonly BroadcastId[],
  ): Promise<ReadonlyMap<string, DeliveryResult>>;
}
