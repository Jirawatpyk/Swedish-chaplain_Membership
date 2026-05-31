/**
 * Application port — unified multi-source member timeline reader.
 *
 * F3 (US6) read from `audit_log` only. F9 (US3) enriches this into a
 * six-source chronological stream (audit · invoice · payment · event ·
 * broadcast · renewal) by reading the `member_timeline_v` SQL view
 * (migrations 0189 + 0192). The view is `security_invoker = on` so
 * base-table RLS scopes every source to the querying tenant.
 *
 * Keyset pagination is on `(occurred_at DESC, ref_id DESC)`; `ref_id` is
 * TEXT (uuid sources cast `::text`, payments are ULID text) so the cursor
 * tiebreak is a lexicographic text comparison, not a uuid comparison.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { TimelineSource, TimelineActorKind } from '@/lib/timeline-shared';
import type { RepoError } from './member-repo';

// Re-export so existing `from '../ports/timeline-port'` consumers (repo,
// use-case) keep working; the canonical definitions live in the client-safe
// leaf `@/lib/timeline-shared` (avoids the client bundling the server graph).
export type { TimelineSource, TimelineActorKind };

/** Fields common to every timeline row regardless of source. */
type TimelineEventBase = {
  /** The source row id (`ref_id`) — uuid or ULID, always text. */
  readonly id: string;
  /** `occurred_at` — event timestamp normalised to UTC. */
  readonly timestamp: Date;
  /**
   * For `source='audit'` this is the audit `event_type` (e.g.
   * `member_plan_changed`) — drives the `audit.eventType.*` label and the
   * payload-formatting switch. For the other sources it is the
   * source-specific event-kind (e.g. invoice `status`) used to resolve the
   * `timeline.<source>.<eventKind>` i18n key (FR-014).
   */
  readonly eventType: string;
  /** staff / member / system — for the actor filter + non-audit display. */
  readonly actorKind: TimelineActorKind;
  readonly payload: Record<string, unknown> | null;
};

/**
 * Audit rows have a real acting user — `actorUserId` is the user id (resolved
 * to `actorDisplayName` when it is a real user UUID; null for system actors).
 */
export type AuditTimelineEvent = TimelineEventBase & {
  readonly source: 'audit';
  readonly actorUserId: string;
  readonly actorDisplayName: string | null;
};

/**
 * The other five sources have no single acting user — the UI renders a
 * localized actor-kind label. Discriminating on `source` makes the
 * "actorUserId only exists for audit rows" invariant compiler-enforced
 * (review-run I5), so no token can masquerade as a user id.
 */
export type SourcedTimelineEvent = TimelineEventBase & {
  readonly source: Exclude<TimelineSource, 'audit'>;
  readonly actorDisplayName: null;
};

export type TimelineEvent = AuditTimelineEvent | SourcedTimelineEvent;

export type TimelineFilter = {
  readonly memberId: string;
  readonly cursor?: string;
  readonly limit: number;
  /** FR-015 — narrow to a single source. */
  readonly source?: TimelineSource;
  /** FR-015 — actor kind (staff / member / system). */
  readonly actorKind?: TimelineActorKind;
  /**
   * FR-015 — inclusive date-range bounds as UTC instants (ISO strings).
   * The use-case converts the caller's `YYYY-MM-DD` tenant-tz calendar day
   * into these UTC bounds; the repo compares `occurred_at` against them.
   */
  readonly fromTs?: string;
  readonly toTs?: string;
};

export type TimelineResult = {
  readonly events: readonly TimelineEvent[];
  readonly nextCursor: string | null;
  /** Total events for this member under the active filters (stable across pages). */
  readonly total: number;
};

export interface TimelinePort {
  listByMember(
    ctx: TenantContext,
    filter: TimelineFilter,
  ): Promise<Result<TimelineResult, RepoError>>;
}
