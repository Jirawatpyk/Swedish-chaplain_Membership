/**
 * F9 US6 (T091 / FR-029) — GDPR audit-subset scoping + redaction.
 *
 * The member's GDPR archive includes the audit events **relevant to them**:
 * both events the member PERFORMED (they are the actor) and events that
 * TARGETED the member's records (FR-029 / clarification 2026 Q: "Both
 * member-performed and member-targeted events"). Third-party PII values and
 * internal-only staff annotations are stripped via the **standard role
 * projection** (`audit-redaction`, the `manager` projection — the most
 * restrictive staff view) so no other data subject's information leaks into the
 * archive.
 *
 * Two responsibilities, both pure (no framework/ORM imports, Principle III):
 *   - `isInMemberAuditSubset` — the scoping predicate (member-performed ∪
 *     member-targeted). The bounded SQL reader (`auth` `gdprAuditSubsetRead`)
 *     applies the same union server-side; this predicate is a defence-in-depth
 *     re-filter at the build layer so a reader drift can never widen the subset.
 *   - `buildMemberAuditSubset` — filter + project each row to a member-facing,
 *     redacted entry (internal actor/target user ids are dropped — they are
 *     third-party identifiers the member's portability right does not extend to;
 *     the redacted `summary` already describes the action).
 *
 * FR-032a (archived/erased subject): this module is purely row-shaped; it never
 * resurrects PII. An erased member's lawfully-retained (pseudonymised) audit
 * rows pass through redaction unchanged — the projection only ever REMOVES data.
 */
import {
  redactPayloadForRole,
  redactSummaryForRole,
} from './audit-redaction';

/** Identifies the data subject across the two id spaces audit_log uses. */
export interface MemberAuditScope {
  /**
   * The user-account ids linked to the member's contacts (a member org can have
   * several portal users — colleagues). Empty when no contact has a portal
   * account, in which case only payload-based member-id scoping applies (the
   * member can never be an `actor_user_id` / `target_user_id`).
   */
  readonly memberUserIds: readonly string[];
  /** The member id (matches `payload.member_id` / `payload.subject_member_id`). */
  readonly memberId: string;
}

/** The minimal row shape the scoping predicate needs. */
export interface ScopableAuditRow {
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly payload: Record<string, unknown> | null;
}

/** A redacted, member-facing audit entry as it appears in `audit-events.json`. */
export interface GdprAuditEntry {
  readonly id: string;
  readonly eventType: string;
  /** ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Redacted free-text summary (emails replaced). */
  readonly summary: string;
  /** Redacted payload (third-party PII + internal annotations stripped). */
  readonly payload: Record<string, unknown> | null;
}

/** The full row shape consumed by `buildMemberAuditSubset` (reader output). */
export interface SubsetSourceRow extends ScopableAuditRow {
  readonly id: string;
  readonly eventType: string;
  readonly summary: string;
  readonly occurredAt: Date;
}

function payloadRef(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  if (payload === null) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/**
 * True iff the row is in the member's audit subset: the member performed it
 * (actor) OR it targeted the member (target user account, or `member_id` /
 * `subject_member_id` in the payload).
 */
export function isInMemberAuditSubset(
  row: ScopableAuditRow,
  scope: MemberAuditScope,
): boolean {
  if (scope.memberUserIds.includes(row.actorUserId)) return true;
  if (row.targetUserId !== null && scope.memberUserIds.includes(row.targetUserId)) {
    return true;
  }
  if (payloadRef(row.payload, 'member_id') === scope.memberId) return true;
  if (payloadRef(row.payload, 'subject_member_id') === scope.memberId) return true;
  return false;
}

/**
 * Filter the reader rows to the member's subset (defence-in-depth re-filter) and
 * project each to a redacted, member-facing entry. The `manager` projection is
 * the most restrictive staff view — it strips internal annotations + third-party
 * emails, guaranteeing no other data subject's PII reaches the archive.
 */
export function buildMemberAuditSubset(
  rows: readonly SubsetSourceRow[],
  scope: MemberAuditScope,
): readonly GdprAuditEntry[] {
  return rows
    .filter((r) => isInMemberAuditSubset(r, scope))
    .map((r) => ({
      id: r.id,
      eventType: r.eventType,
      occurredAt: r.occurredAt.toISOString(),
      summary: redactSummaryForRole(r.summary, 'manager'),
      payload: redactPayloadForRole(r.eventType, r.payload, 'manager'),
    }));
}
