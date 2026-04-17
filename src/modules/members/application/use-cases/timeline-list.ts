/**
 * T130 — US6 timeline-list use case.
 *
 * Queries the append-only audit_log filtered by member_id in the JSONB
 * payload, ordered newest-first, with cursor-based pagination in batches
 * of up to 50. Member-role callers receive a redacted projection
 * (override reasons + internal notes stripped from payloads).
 *
 * FR-020: per-member timeline, paginated in batches of 50, newest-first.
 * FR-023: audit events read from the shared audit_log.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { TimelinePort, TimelineEvent } from '../ports/timeline-port';
import type { MemberRepo } from '../ports/member-repo';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const timelineListSchema = z.object({
  memberId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type TimelineListInput = z.infer<typeof timelineListSchema>;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type TimelineListError =
  | { type: 'not_found'; message: string }
  | { type: 'invalid_input'; message: string }
  | { type: 'server_error'; message: string };

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

/** Fields stripped from payload for non-admin callers (US6 AS3). */
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
  return events.map((e) => ({
    ...e,
    payload: redactPayload(e.payload),
  }));
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export type TimelineListOutput = {
  readonly memberId: string;
  readonly events: readonly import('../ports/timeline-port').TimelineEvent[];
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

  const { memberId, cursor, limit } = parsed.data;

  // 2. Verify member exists in this tenant (prevents cross-tenant timeline)
  const memberResult = await deps.memberRepo.findById(ctx, memberId as import('../../domain/member').MemberId);
  if (!memberResult.ok) {
    if (memberResult.error.code === 'repo.not_found') {
      return err({ type: 'not_found', message: 'Member not found' });
    }
    return err({ type: 'server_error', message: 'Failed to verify member' });
  }

  // 3. Query timeline
  // Spread `cursor` conditionally — `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional-only property.
  const timelineResult = await deps.timeline.listByMember(ctx, {
    memberId,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });

  if (!timelineResult.ok) {
    return err({ type: 'server_error', message: 'Failed to load timeline' });
  }

  // 4. Redact for member-role callers (US6 AS3)
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
