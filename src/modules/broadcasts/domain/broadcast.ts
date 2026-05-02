/**
 * T027 — `Broadcast` aggregate root (F7).
 *
 * One row per E-Blast request across its full lifecycle. Pure TypeScript
 * interface + branded UUID + smart constructors. Mirrors the row shape
 * of `broadcasts` table (Infrastructure schema), domain-typed.
 *
 * State machine: see `policies/broadcast-status-transitions.ts`.
 * Quota accounting: see `value-objects/quota-counter.ts`.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { BroadcastStatus } from './value-objects/broadcast-status';
import type { BroadcastSegmentType } from './value-objects/segment-type';

declare const BroadcastIdBrand: unique symbol;
export type BroadcastId = string & { readonly [BroadcastIdBrand]: true };

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BroadcastIdError = {
  readonly kind: 'invalid_broadcast_id';
  readonly raw: string;
};

/**
 * Unchecked brand cast. Use only in TRUSTED contexts:
 *   - DB row → domain mapping (Postgres enforces uuid format on the column)
 *   - IDs just generated with `randomUUID()`
 *   - Test fixtures
 *
 * For untrusted input (route parameters, request bodies), use
 * `parseBroadcastId` which validates UUID format — letting a malformed
 * id reach Drizzle would surface as Postgres `22P02` invalid_text_representation
 * (an opaque 5xx instead of a clean `broadcast_not_found` 404).
 */
export function asBroadcastId(raw: string): BroadcastId {
  return raw as BroadcastId;
}

export function parseBroadcastId(
  raw: string,
): Result<BroadcastId, BroadcastIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_broadcast_id', raw });
  }
  return ok(raw as BroadcastId);
}

/**
 * Submission origin (Q12 dual-actor + N1 remediation 2026-04-29).
 * Mirrors the `broadcastActorRoleEnum` 3 values. Owned at Domain
 * layer because it influences the audit-event payload shape (admin
 * proxy submissions carry both `requestedByMemberId` and
 * `submittedByUserId` — different actors).
 */
export type BroadcastActorRole =
  | 'member_self_service'
  | 'admin_proxy'
  | 'system';

/**
 * `Broadcast` aggregate root. Pure data interface (no class).
 *
 * Fields are grouped by lifecycle phase; nullables track which phase
 * the broadcast has reached:
 *   - `submittedAt` non-null iff status >= submitted
 *   - `approvedAt` non-null iff status >= approved (excluding rejected/cancelled)
 *   - `sendingStartedAt` non-null iff status >= sending
 *   - `sentAt` non-null iff status === sent
 *   - `quotaYearConsumed` + `quotaConsumedAt` non-null iff status === sent
 *     (FR-007 — enforced by `broadcasts_quota_year_only_on_sent` CHECK
 *     at DB layer)
 *
 * The `one-active-broadcast-state` invariant in `invariants/` enforces
 * the timestamp/status agreement at Application boundary.
 */
export interface Broadcast {
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;

  // Originator (FR-005 + Q12 dual-actor)
  readonly requestedByMemberId: string;
  readonly requestedByMemberPlanIdSnapshot: string;
  readonly submittedByUserId: string;
  readonly actorRole: BroadcastActorRole;

  // Content (Q3 immutable after submit)
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  readonly fromName: string;
  readonly replyToEmail: string;

  // Recipient targeting
  readonly segmentType: BroadcastSegmentType;
  readonly segmentParams: Record<string, unknown> | null;
  readonly customRecipientEmails: ReadonlyArray<string> | null;
  readonly estimatedRecipientCount: number;

  // Lifecycle
  readonly status: BroadcastStatus;
  readonly submittedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly approvedByUserId: string | null;
  readonly rejectedAt: Date | null;
  readonly rejectedByUserId: string | null;
  readonly rejectionReason: string | null;
  readonly scheduledFor: Date | null;
  readonly sendingStartedAt: Date | null;
  readonly sentAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelledByUserId: string | null;
  /**
   * Polymorphic by writer (Round 5 review type-design — DELIBERATELY
   * not bounded to an enum):
   *   - System cascade writers carry one of `SystemCancellationReason`
   *     (`'originator_member_deleted' | 'gdpr_erasure_request' |
   *     'pdpa_deletion_request'`) — bounded enum enforced at the
   *     `cancelInFlightForMember` port boundary.
   *   - Member self-cancel writers carry up to 500 chars of admin-
   *     visible free text (validated at `cancel-broadcast.ts` use-case
   *     boundary).
   * The persisted column is `text NULL` because both shapes need to
   * round-trip; downstream readers (admin notification email, audit
   * payload) format conditionally on actor_role rather than parsing
   * the reason string.
   */
  readonly cancellationReason: string | null;
  readonly failedToDispatchAt: Date | null;
  /**
   * Free-text dispatch failure forensic (NOT bounded to an enum) —
   * carries either a mapped phase label
   * (`'audience_post_suppression_empty'` etc.) or the underlying
   * error message from the Resend gateway / app code. The bounded
   * counterpart used for alerting is the
   * `broadcasts.failed_to_dispatch.count.failure_reason` enum
   * emitted by `phaseToFailureReason()` in
   * `dispatch-scheduled-broadcast.ts` — dashboards alert on that
   * enum; the `failureReason` column is for human triage in the
   * admin queue. Round 5 review: documented choice, not regression.
   */
  readonly failureReason: string | null;

  // Quota accounting (FR-003 + FR-006 + FR-007)
  readonly quotaYearConsumed: number | null;
  readonly quotaConsumedAt: Date | null;

  // Resend integration
  readonly resendAudienceId: string | null;
  readonly resendBroadcastId: string | null;

  // Audit retention (Constitution v1.4.0)
  readonly retentionYears: 5 | 10;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Round 5 review type-design — phase-narrowed view of a `Broadcast`.
 *
 * The `Broadcast` interface above is a flat record shape because the
 * row schema is flat and every use-case mutates a small subset of
 * lifecycle fields under tx (changing topology to a per-status DU
 * would require simultaneous rewrite of ~15 use-cases + the Drizzle
 * mapper + ~70 test fixtures, with high regression risk).
 *
 * `BroadcastPhase` is the OPT-IN narrowed view: callers that want
 * compile-time non-null guarantees on lifecycle timestamps (e.g. the
 * dispatch use-case asserting `submittedAt + approvedAt + scheduledFor`
 * are non-null) call `phaseOf(broadcast)` and switch on the discriminator
 * — TS narrows the timestamp fields per branch.
 *
 * Migration policy: when adding NEW use-cases that need
 * timestamp non-null guarantees, prefer `phaseOf` over inline
 * `if (b.submittedAt === null) throw`. The legacy use-cases keep their
 * inline guards for now; sweeping them is post-MVP polish.
 */
export type BroadcastPhase =
  | { readonly kind: 'draft'; readonly createdAt: Date }
  | {
      readonly kind: 'submitted';
      readonly submittedAt: Date;
      readonly submittedByUserId: string;
    }
  | {
      readonly kind: 'approved';
      readonly submittedAt: Date;
      readonly approvedAt: Date;
      readonly approvedByUserId: string;
      readonly scheduledFor: Date | null;
    }
  | {
      readonly kind: 'rejected';
      readonly rejectedAt: Date;
      readonly rejectedByUserId: string;
      readonly rejectionReason: string | null;
    }
  | {
      readonly kind: 'sending';
      readonly sendingStartedAt: Date;
      readonly approvedAt: Date;
    }
  | {
      readonly kind: 'sent';
      readonly sentAt: Date;
      readonly quotaYearConsumed: number;
      readonly quotaConsumedAt: Date;
    }
  | {
      readonly kind: 'cancelled';
      readonly cancelledAt: Date;
      readonly cancellationReason: string | null;
    }
  | {
      readonly kind: 'failed_to_dispatch';
      readonly failedToDispatchAt: Date;
      readonly failureReason: string | null;
    };

/**
 * Round 5 review type-design — narrow a flat `Broadcast` row to its
 * phase-discriminated view. Throws if the row violates the
 * status/timestamp invariant (defensive; the
 * `one-active-broadcast-state` policy enforces this at the Application
 * boundary, but a row corrupted by an out-of-band write would surface
 * here rather than panic deeper in a use-case).
 */
export function phaseOf(b: Broadcast): BroadcastPhase {
  switch (b.status) {
    case 'draft':
      return { kind: 'draft', createdAt: b.createdAt };
    case 'submitted':
      if (b.submittedAt === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='submitted' but submittedAt is null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'submitted',
        submittedAt: b.submittedAt,
        submittedByUserId: b.submittedByUserId,
      };
    case 'approved':
      if (b.submittedAt === null || b.approvedAt === null || b.approvedByUserId === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='approved' but lifecycle timestamps null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'approved',
        submittedAt: b.submittedAt,
        approvedAt: b.approvedAt,
        approvedByUserId: b.approvedByUserId,
        scheduledFor: b.scheduledFor,
      };
    case 'rejected':
      if (b.rejectedAt === null || b.rejectedByUserId === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='rejected' but rejectedAt/rejectedByUserId null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'rejected',
        rejectedAt: b.rejectedAt,
        rejectedByUserId: b.rejectedByUserId,
        rejectionReason: b.rejectionReason,
      };
    case 'sending':
      if (b.sendingStartedAt === null || b.approvedAt === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='sending' but sendingStartedAt/approvedAt null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'sending',
        sendingStartedAt: b.sendingStartedAt,
        approvedAt: b.approvedAt,
      };
    case 'sent':
      if (
        b.sentAt === null ||
        b.quotaYearConsumed === null ||
        b.quotaConsumedAt === null
      ) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='sent' but sentAt/quotaYearConsumed/quotaConsumedAt null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'sent',
        sentAt: b.sentAt,
        quotaYearConsumed: b.quotaYearConsumed,
        quotaConsumedAt: b.quotaConsumedAt,
      };
    case 'cancelled':
      if (b.cancelledAt === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='cancelled' but cancelledAt null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'cancelled',
        cancelledAt: b.cancelledAt,
        cancellationReason: b.cancellationReason,
      };
    case 'failed_to_dispatch':
      if (b.failedToDispatchAt === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='failed_to_dispatch' but failedToDispatchAt null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'failed_to_dispatch',
        failedToDispatchAt: b.failedToDispatchAt,
        failureReason: b.failureReason,
      };
  }
}
