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

  // F7.1a US1 (Phase 2 0162 ADD COLUMN + Phase 3 B0 type extension).
  // `manualRetryCount` — admin retry budget per FR-008a (CHECK 0..3
  // in migration 0162). Defaults to 0 on existing F7 MVP rows.
  // `partialDeliveryAcceptedAt` + `partialDeliveryAcceptedByUserId` —
  // set when admin clicks "Accept partial delivery" (FR-008c).
  readonly manualRetryCount: number;
  readonly partialDeliveryAcceptedAt: Date | null;
  readonly partialDeliveryAcceptedByUserId: string | null;

  // F7.1a US7 (Phase 2 0162 ADD COLUMN). FK to broadcast_templates;
  // null if the draft was Blank. `templateNameSnapshot` is the
  // denormalised template name at snapshot time (FR-019 critique P9
  // — survives template deletion for forensic audit).
  readonly startedFromTemplateId: string | null;
  readonly templateNameSnapshot: string | null;

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
    }
  // F7.1a US1 (Phase 3 B0 — added 2026-05-19, FR-008a/b).
  | {
      readonly kind: 'partially_sent';
      readonly sendingStartedAt: Date;
      readonly approvedAt: Date;
      readonly manualRetryCount: number; // 0..3 (CHECK in migration 0162)
    }
  | {
      readonly kind: 'partial_delivery_accepted';
      readonly partialDeliveryAcceptedAt: Date;
      readonly partialDeliveryAcceptedByUserId: string;
      readonly quotaYearConsumed: number;
      readonly quotaConsumedAt: Date;
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
    case 'partially_sent':
      if (b.sendingStartedAt === null || b.approvedAt === null) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='partially_sent' but sendingStartedAt or approvedAt null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'partially_sent',
        sendingStartedAt: b.sendingStartedAt,
        approvedAt: b.approvedAt,
        manualRetryCount: b.manualRetryCount,
      };
    case 'partial_delivery_accepted':
      if (
        b.partialDeliveryAcceptedAt === null ||
        b.partialDeliveryAcceptedByUserId === null ||
        b.quotaYearConsumed === null ||
        b.quotaConsumedAt === null
      ) {
        throw new Error(
          `BroadcastPhaseInvariantViolation: status='partial_delivery_accepted' but required fields null (broadcastId=${b.broadcastId})`,
        );
      }
      return {
        kind: 'partial_delivery_accepted',
        partialDeliveryAcceptedAt: b.partialDeliveryAcceptedAt,
        partialDeliveryAcceptedByUserId: b.partialDeliveryAcceptedByUserId,
        quotaYearConsumed: b.quotaYearConsumed,
        quotaConsumedAt: b.quotaConsumedAt,
      };
  }
}

// ---------------------------------------------------------------------------
// T043 (F7.1a US1) — Broadcast aggregate state-transition methods.
//
// Standalone functions over the flat `Broadcast` interface (matches F7
// MVP pattern — class-style aggregates were rejected during F7 design
// per Round 5 review type-design; flat interfaces + phase narrowing
// keep Drizzle row mapping trivial).
//
// All return `Result<Broadcast, BroadcastStateError>` so callers can
// chain transitions without throwing. Persistence is the caller's
// responsibility (Application use-case writes the resulting Broadcast
// via repo); these functions are PURE — no I/O, no clock injection.
// Callers pass `now` from their `ClockPort` for testability.
// ---------------------------------------------------------------------------

export type BroadcastStateError =
  | {
      readonly code: 'broadcast.invalid_state_for_action';
      readonly action:
        | 'recordPartialSend'
        | 'transitionToRetrying'
        | 'acceptPartialDelivery';
      readonly currentStatus: BroadcastStatus;
      readonly requiredStatus: BroadcastStatus | readonly BroadcastStatus[];
    }
  | {
      readonly code: 'broadcast.manual_retry_budget_exhausted';
      readonly broadcastId: BroadcastId;
      readonly currentCount: number;
      readonly maxAllowed: 3;
    };

/**
 * Transition `sending → partially_sent` when ≥1 batch reached terminal
 * `failed` after exhausting per-batch retry budget (FR-008a).
 *
 * Caller (Application use case Phase 3 T044/T045 reconcile-stuck-
 * sending extension OR T056 webhook ext) supplies the list of failed
 * batch IDs purely for the audit-event payload — Broadcast itself
 * doesn't track failed-batch state (that's in broadcast_batch_manifests).
 *
 * Returns the mutated broadcast snapshot. Caller persists via repo
 * inside the same `runInTenant` transaction that touched the
 * batch_manifest rows.
 */
export function recordPartialSend(
  broadcast: Broadcast,
  _failedBatchIds: readonly string[],
  _now: Date,
): Result<Broadcast, BroadcastStateError> {
  if (broadcast.status !== 'sending') {
    return err({
      code: 'broadcast.invalid_state_for_action',
      action: 'recordPartialSend',
      currentStatus: broadcast.status,
      requiredStatus: 'sending',
    });
  }
  return ok({ ...broadcast, status: 'partially_sent' });
}

/**
 * Transition `partially_sent → sending` on admin retry click.
 * Increments `manualRetryCount` (CHECK 0..3 enforced at DB layer +
 * here at Domain layer).
 *
 * Application use case T047 wraps this in a `pg_advisory_xact_lock(
 * 'broadcasts-retry:'+tenantId+':'+broadcastId)` per FR-008d to
 * serialise concurrent admin retries. The lock is the use case's
 * responsibility — this function is pure.
 */
export function transitionToRetrying(
  broadcast: Broadcast,
  _actor: { readonly userId: string },
  _now: Date,
): Result<Broadcast, BroadcastStateError> {
  if (broadcast.status !== 'partially_sent') {
    return err({
      code: 'broadcast.invalid_state_for_action',
      action: 'transitionToRetrying',
      currentStatus: broadcast.status,
      requiredStatus: 'partially_sent',
    });
  }
  const MAX_RETRIES = 3 as const;
  if (broadcast.manualRetryCount >= MAX_RETRIES) {
    return err({
      code: 'broadcast.manual_retry_budget_exhausted',
      broadcastId: broadcast.broadcastId,
      currentCount: broadcast.manualRetryCount,
      maxAllowed: MAX_RETRIES,
    });
  }
  return ok({
    ...broadcast,
    status: 'sending',
    manualRetryCount: broadcast.manualRetryCount + 1,
  });
}

/**
 * Transition `partially_sent → partial_delivery_accepted` (terminal)
 * on admin "Accept partial delivery" action. Records actor + accept
 * timestamp (caller-supplied so the same `now` shows up in audit
 * payload + row).
 *
 * Note: this transition CONSUMES quota (FR-007 + FR-008c) — the
 * partially-delivered count is real send activity. The caller's use
 * case (T048) ALSO sets `quotaYearConsumed` + `quotaConsumedAt` if
 * they weren't already set (e.g., admin accepts before all batches
 * even attempted). The `one-active-broadcast-state` invariant
 * (Domain/invariants/) requires both quota fields non-null in the
 * terminal state.
 */
export function acceptPartialDelivery(
  broadcast: Broadcast,
  actor: { readonly userId: string },
  now: Date,
): Result<Broadcast, BroadcastStateError> {
  if (broadcast.status !== 'partially_sent') {
    return err({
      code: 'broadcast.invalid_state_for_action',
      action: 'acceptPartialDelivery',
      currentStatus: broadcast.status,
      requiredStatus: 'partially_sent',
    });
  }
  return ok({
    ...broadcast,
    status: 'partial_delivery_accepted',
    partialDeliveryAcceptedAt: now,
    partialDeliveryAcceptedByUserId: actor.userId,
  });
}
