/**
 * timeline-list use case — F3 (US6) → F9 (US3) unified multi-source timeline.
 *
 * Queries `member_timeline_v` (six sources: audit · invoice · payment · event ·
 * broadcast · renewal) for one member, newest-first, keyset-paginated in
 * batches of up to 100. Supports filtering by source, actor kind, and date
 * range (FR-015). Member-role callers receive a redacted projection (override
 * reasons + internal notes stripped from payloads — FR-017).
 *
 * Date bounds (`from`/`to`) are UTC ISO instants — the presentation layer
 * converts the caller's `YYYY-MM-DD` tenant-tz calendar day into UTC via
 * `@/lib/tenant-day-range` (same pattern as the F9 audit viewer), keeping the
 * tenant-timezone concern out of this application-layer use case.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { TIMELINE_SOURCES, TIMELINE_ACTOR_KINDS } from '@/lib/timeline-shared';
import type { TenantContext } from '@/modules/tenants';
import type {
  TimelinePort,
  TimelineEvent,
  TimelineFilter,
} from '../ports/timeline-port';
import type { MemberRepo } from '../ports/member-repo';

// Re-export the client-safe source/actor enums so the public barrel can keep
// surfacing them from this use case (the canonical defs live in
// `@/lib/timeline-shared` — a pure leaf the client `<TimelineFilters>` imports
// directly, avoiding the server-graph bundling that the barrel would cause).
export { TIMELINE_SOURCES, TIMELINE_ACTOR_KINDS };

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const timelineListSchema = z.object({
  memberId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  /** FR-015 — narrow to a single source. */
  source: z.enum(TIMELINE_SOURCES).optional(),
  /** FR-015 — actor kind (staff / member / system). */
  actorKind: z.enum(TIMELINE_ACTOR_KINDS).optional(),
  /** FR-015 — inclusive lower bound, UTC ISO instant (resolved by presentation). */
  from: z.string().optional(),
  /** FR-015 — inclusive upper bound, UTC ISO instant (resolved by presentation). */
  to: z.string().optional(),
});

export type TimelineListInput = z.infer<typeof timelineListSchema>;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type TimelineListError =
  | { type: 'not_found'; message: string }
  | { type: 'invalid_input'; message: string }
  // `cause` is the underlying Error thrown by the repo (e.g. a NeonDbError),
  // unwrapped from the `repo.unexpected` RepoError wrapper, so the route's
  // single-`.cause` `errKind(...)` logs the real class — not 'unknown'
  // (review-run I1; code-review max F9 #7/#9).
  | { type: 'server_error'; message: string; cause?: unknown };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type TimelineListDeps = {
  readonly memberRepo: MemberRepo;
  readonly timeline: TimelinePort;
};

// ---------------------------------------------------------------------------
// Redaction (member-role projection)
// ---------------------------------------------------------------------------

/** Fields stripped from payload for non-admin callers (US6 AS3 / FR-017). */
const REDACTED_PAYLOAD_KEYS = new Set([
  'override_reason_code',
  'override_reason_note',
  'notes',
  'old_notes',
  'new_notes',
]);

function redactPayload(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) return null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!REDACTED_PAYLOAD_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function redactEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.map((e) => {
    const redactedPayload = redactPayload(e.payload);
    // Member projection MUST NOT expose the acting STAFF user's id/name on an
    // audit row (R004 — migration 0192 injects actor_user_id into
    // member_timeline_v; a member viewing their own history should never see
    // which staff UUID edited their record). Blank both for audit rows.
    if (e.source === 'audit') {
      return { ...e, payload: redactedPayload, actorUserId: '', actorDisplayName: null };
    }
    return { ...e, payload: redactedPayload };
  });
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export type TimelineListOutput = {
  readonly memberId: string;
  readonly events: readonly TimelineEvent[];
  readonly nextCursor: string | null;
  readonly total: number;
};

export async function timelineList(
  input: TimelineListInput,
  meta: { actorUserId: string; actorRole: 'admin' | 'manager' | 'member'; requestId: string },
  ctx: TenantContext,
  deps: TimelineListDeps,
): Promise<Result<TimelineListOutput, TimelineListError>> {
  // 1. Validate input
  const parsed = timelineListSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_input',
      message: parsed.error.issues.map((i) => i.message).join('; '),
    });
  }

  const { memberId, cursor, limit, source, actorKind, from, to } = parsed.data;

  // 1a. Value-validate the date bounds (presentation passes UTC ISO instants).
  //     A malformed/impossible date is rejected here rather than reaching the
  //     repo's `::timestamptz` cast (which would surface as a 500).
  // Forward the VALIDATED original ISO string — do NOT round-trip through
  // `new Date(...).toISOString()`, which truncates µs to ms and would silently
  // re-drop the day's final-µs window the `tenantDayEndUtc` .999999 cap exists
  // to keep (the repo casts `${toTs}::timestamptz`, preserving full precision).
  // (code-review Round 2 — R2 #14-dead fix)
  let fromTs: string | undefined;
  let toTs: string | undefined;
  if (from !== undefined) {
    if (Number.isNaN(new Date(from).getTime())) {
      return err({ type: 'invalid_input', message: 'Invalid "from" date' });
    }
    fromTs = from;
  }
  if (to !== undefined) {
    if (Number.isNaN(new Date(to).getTime())) {
      return err({ type: 'invalid_input', message: 'Invalid "to" date' });
    }
    toTs = to;
  }
  if (fromTs && toTs && new Date(fromTs).getTime() > new Date(toTs).getTime()) {
    return err({ type: 'invalid_input', message: '"from" must be on or before "to"' });
  }

  // 2. Verify member exists in this tenant (prevents cross-tenant timeline)
  const memberResult = await deps.memberRepo.findById(
    ctx,
    memberId as import('../../domain/member').MemberId,
  );
  if (!memberResult.ok) {
    if (memberResult.error.code === 'repo.not_found') {
      return err({ type: 'not_found', message: 'Member not found' });
    }
    return err({
      type: 'server_error',
      message: 'Failed to verify member',
      // Thread the UNDERLYING error (repo.unexpected.cause), not the RepoError
      // wrapper: the routes log `errKind(result.error.cause)` with a single
      // unwrap, and errKind on the plain `{ code, cause }` wrapper always yields
      // 'unknown'. (code-review max F9 — finding #7/#9)
      cause: (memberResult.error as { cause?: unknown }).cause,
    });
  }

  // 3. Query timeline. Spread optional fields conditionally —
  //    `exactOptionalPropertyTypes` forbids assigning `undefined`.
  const filter: TimelineFilter = {
    memberId,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(actorKind !== undefined ? { actorKind } : {}),
    ...(fromTs !== undefined ? { fromTs } : {}),
    ...(toTs !== undefined ? { toTs } : {}),
  };

  const timelineResult = await deps.timeline.listByMember(ctx, filter);

  if (!timelineResult.ok) {
    return err({
      type: 'server_error',
      message: 'Failed to load timeline',
      // Underlying error, not the RepoError wrapper (see member-verify branch
      // above) — keeps the routes' single `.cause` unwrap on a real Error so
      // `errKind` logs the actual class (e.g. NeonDbError), not 'unknown'.
      cause: (timelineResult.error as { cause?: unknown }).cause,
    });
  }

  // 4. Redact for member-role callers (US6 AS3 / FR-017)
  const { events, nextCursor, total } = timelineResult.value;
  const projectedEvents =
    meta.actorRole === 'member' ? redactEvents(events) : events;

  return ok({
    memberId,
    events: projectedEvents,
    nextCursor,
    total,
  });
}
