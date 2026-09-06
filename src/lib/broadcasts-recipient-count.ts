/**
 * 108 PR-C T088 (US5 / FR-040, FR-040a, FR-040b, FR-042; contract
 * broadcast-audience § 5) — the shared half of the two recipient-count
 * endpoints (`GET /api/broadcasts/recipient-count` for the member compose
 * page, `GET /api/admin/broadcasts/recipient-count` for the admin proxy
 * compose). Each route owns its gate and its `requestingMemberId`; this
 * module owns the query contract, the limiter key and the numbers-only
 * envelope so the two can never drift.
 *
 * The count IS the resolver (`resolveSegmentRecipients`) — the single source
 * of truth for "who receives" — run for the caller's member with
 * `phase: 'submit'`: a compose-time count must not keep the DISPATCH-side
 * opt-out metric series alive (the emit-at-zero canary from PR-D).
 *
 * Numbers only (FR-040a): the body never carries an address, a member id or a
 * contact id. Over the ceiling the TRUE count is returned with
 * `exceeds: true` (FR-041 — never truncated); an empty audience is `0`; a
 * failed resolve is `unavailable`, which the route turns into 503
 * `count_unavailable` so the client shows "count unavailable", never a stale
 * number (FR-040b).
 */
import { z } from 'zod';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { resolveSegmentRecipients, type ResolveSegmentDeps } from '@/modules/broadcasts';
import type { RecipientSegment } from '@/modules/broadcasts/domain/recipient-segment';

/** FR-040 / contract § 5 — 30 counts per minute per (tenant, user), atomic. */
export const RECIPIENT_COUNT_RATE_MAX = 30;
export const RECIPIENT_COUNT_RATE_WINDOW_SECONDS = 60;

export function recipientCountRateKey(tenantSlug: string, userId: string): string {
  return `broadcasts:count:${tenantSlug}:${userId}`;
}

const TIER_CODE_MAX = 20;

const querySchema = z.object({
  segment: z.enum(['all_members', 'tier', 'event_attendees_last_90d']),
  // `tier=a,b` — comma-separated codes; required (non-empty) for `tier`.
  tier: z.string().max(2_000).optional(),
});

/**
 * Parse the count query into a countable segment. The custom list is counted
 * client-side after validation (contract § 5) and is NOT accepted here.
 */
export function parseRecipientCountQuery(
  searchParams: URLSearchParams,
): { readonly ok: true; readonly segment: RecipientSegment } | { readonly ok: false } {
  const parsed = querySchema.safeParse({
    segment: searchParams.get('segment') ?? undefined,
    tier: searchParams.get('tier') ?? undefined,
  });
  if (!parsed.success) return { ok: false };
  const { segment, tier } = parsed.data;
  if (segment === 'tier') {
    const tierCodes = (tier ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c.length <= 64);
    if (tierCodes.length === 0 || tierCodes.length > TIER_CODE_MAX) return { ok: false };
    return { ok: true, segment: { kind: 'tier', tierCodes } };
  }
  return { ok: true, segment: { kind: segment } };
}

export interface RecipientCountBody {
  readonly count: number;
  readonly ceiling: number;
  readonly exceeds: boolean;
  readonly orphans: number;
  readonly droppedByPreference: number;
}

export type RecipientCountOutcome =
  | { readonly status: 'ok'; readonly body: RecipientCountBody }
  | { readonly status: 'unavailable' };

/**
 * Run the resolver for `requestingMemberId` and reduce its Result to the
 * numbers-only envelope. Never throws: a thrown resolve (the fail-closed
 * opt-out lookup) and a typed `resolve.server_error` both become
 * `unavailable`, logged with the error class only.
 */
export async function countRecipients(
  deps: ResolveSegmentDeps,
  input: {
    readonly segment: RecipientSegment;
    readonly requestingMemberId: string;
    readonly correlationId: string;
  },
): Promise<RecipientCountOutcome> {
  const ceiling = deps.audienceCeiling;
  try {
    const result = await resolveSegmentRecipients(deps, {
      segment: input.segment,
      phase: 'submit',
      requestingMemberId: input.requestingMemberId,
      customRecipients: null,
    });
    if (result.ok) {
      return {
        status: 'ok',
        body: {
          count: result.value.estimatedCount,
          ceiling,
          exceeds: false,
          orphans: result.value.orphans.length,
          droppedByPreference: result.value.droppedByPreference,
        },
      };
    }
    switch (result.error.kind) {
      case 'broadcast_audience_too_large':
        return {
          status: 'ok',
          body: { count: result.error.count, ceiling: result.error.cap, exceeds: true, orphans: 0, droppedByPreference: 0 },
        };
      case 'broadcast_empty_segment_blocked':
        return { status: 'ok', body: { count: 0, ceiling, exceeds: false, orphans: 0, droppedByPreference: 0 } };
      case 'resolve.server_error':
        logger.error(
          { tenantId: deps.tenant.slug, correlationId: input.correlationId, err: result.error.message },
          'broadcasts.recipient_count.resolve_failed',
        );
        return { status: 'unavailable' };
      default: {
        const _exhaustive: never = result.error;
        logger.error(
          { tenantId: deps.tenant.slug, correlationId: input.correlationId, err: _exhaustive },
          'broadcasts.recipient_count.unhandled_error_variant',
        );
        return { status: 'unavailable' };
      }
    }
  } catch (e) {
    logger.error(
      { tenantId: deps.tenant.slug, correlationId: input.correlationId, err: errKind(e) },
      'broadcasts.recipient_count.resolve_threw',
    );
    return { status: 'unavailable' };
  }
}
