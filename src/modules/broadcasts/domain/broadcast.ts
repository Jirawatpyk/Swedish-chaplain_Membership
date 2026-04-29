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
  readonly cancellationReason: string | null;
  readonly failedToDispatchAt: Date | null;
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
