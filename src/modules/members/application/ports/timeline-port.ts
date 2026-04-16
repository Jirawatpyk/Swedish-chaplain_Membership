/**
 * Application port — Timeline reader for per-member audit history (US6).
 *
 * Reads from the shared `audit_log` table filtered by `payload->>'member_id'`.
 * The infrastructure adapter uses the existing F3 member_id JSONB index
 * (`audit_log_member_id_idx`) for performant lookups.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { RepoError } from './member-repo';

export type TimelineEvent = {
  readonly id: string;
  readonly timestamp: Date;
  readonly eventType: string;
  readonly actorUserId: string;
  /**
   * Human-readable actor label resolved from `users.display_name` or
   * `users.email` when `actorUserId` is a real user UUID. For synthetic
   * actors (`system`, `anonymous`, `system:bootstrap`) this is `null`
   * and the UI falls back to a localized "System" label.
   */
  readonly actorDisplayName: string | null;
  readonly payload: Record<string, unknown> | null;
};

export type TimelineFilter = {
  readonly memberId: string;
  readonly cursor?: string;
  readonly limit: number;
};

export type TimelineResult = {
  readonly events: readonly TimelineEvent[];
  readonly nextCursor: string | null;
  /** Total events for this member (stable across pages). */
  readonly total: number;
};

export interface TimelinePort {
  listByMember(
    ctx: TenantContext,
    filter: TimelineFilter,
  ): Promise<Result<TimelineResult, RepoError>>;
}
