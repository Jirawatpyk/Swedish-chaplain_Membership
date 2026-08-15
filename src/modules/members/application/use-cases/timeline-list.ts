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
import { rootCause } from '@/lib/log-id';
import { TIMELINE_SOURCES, TIMELINE_ACTOR_KINDS } from '@/lib/timeline-shared';
import type { Role } from '@/modules/auth';
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
  /**
   * Whether the viewer holds `invoicing.read` (016 review, security I-1).
   *
   * The timeline route is gated on `members.read`, which the `marketing` bundle
   * carries — and the timeline's payment rows carry `amount_satang` while its
   * F4 audit rows carry `total_satang` / `credit_amount_satang`. Without this
   * gate the role that PR 4 deliberately excluded from the revenue dashboard
   * reads per-member money one page over.
   *
   * INJECTED, because the Application layer must not import `canPerform`
   * (it reads `env`).
   *
   * REQUIRED. It shipped optional-and-fail-closed, and four of the six call
   * sites then forgot it — all four SSR paths. Fail-closed meant the failure
   * was quiet in the worst way: members stopped seeing their OWN invoices on
   * page 1 of the portal timeline while the API-driven "load more" still
   * returned them, and the header count kept counting rows the page no longer
   * showed. `ListDashboardDeps.canFinance` made the same parameter mandatory
   * and has zero misses; this follows it.
   */
  readonly invoicingRead: boolean;
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

/**
 * Timeline rows that carry money, dropped for a viewer without `invoicing.read`.
 *
 * Dropped WHOLE rather than field-scrubbed: an invoice or payment row with its
 * amounts removed still discloses that the member was billed, what document
 * number was issued and when — and the row's own copy
 * (`resolve-invoice-event-copy.ts`) renders from those fields, so a scrubbed row
 * would render as a broken sentence. There is no partial version of this row
 * that is both safe and useful.
 */
const MONEY_SOURCES: ReadonlySet<string> = new Set(['invoice', 'payment']);

/**
 * F4 event types that ride the `audit` source and carry money. Matched by
 * prefix so a new `invoice_*` / `credit_note_*` / `refund_*` / `payment_*`
 * event is excluded by default.
 *
 * A CHEAP FIRST PASS ONLY — see `hasMoneyShapedPayload`. The first version of
 * this gate relied on the prefixes alone and leaked: `renewal_auto_drafted`
 * (`frozen_price_thb`), `member_plan_change_billing_effect`
 * (`old_price_thb` / `new_price_thb`) and `renewal_invoice_created`
 * (`total_satang`) all carry `member_id` plus a price and match none of them.
 */
// Exported for the divergence-freeze pin in timeline-list-filters.test.ts
// (financial review 2026-08-14): the app applies these prefixes to EVERY
// source's eventType while the SQL twin scopes them to source='audit' — a
// superset that holds only while no non-audit status value starts with one
// of these. The pin freezes that condition instead of trusting it.
export const MONEY_AUDIT_PREFIXES = ['invoice_', 'credit_note_', 'refund_', 'payment_'] as const;

/**
 * Money identified by the SHAPE of the payload rather than the name of the
 * event that produced it.
 *
 * Naming is the wrong axis: it requires every future emitter to pick a blessed
 * prefix, and three shipped ones already do not. The unit that actually leaks
 * is a payload KEY, so that is what this matches — `*_satang`, `*_thb`, and
 * anything spelled `price` or `amount`. Recursive, because F4 payloads nest
 * (`{ totals: { total_satang } }`).
 *
 * Deliberately broad. A false positive costs one hidden timeline row for a
 * viewer who could not open the money surface it describes anyway; a false
 * negative is a per-member figure on a page whose role label promises the
 * opposite.
 */
const MONEY_KEY_RE = /(_satang|_thb)$|price|amount/i;

// Depth cap raised 4 → 12 (016 post-ship review, Angle A #6): a money key
// five levels deep escaped the probe. 12 is far beyond any real audit payload
// while still bounding recursion on a pathological value; the SQL-side twin
// in the repo (`MONEY_KEY_TEXT_PATTERN`, applied when `excludeMoney` is set)
// is depth-unlimited and is the authoritative gate — this app-side probe is
// belt-and-braces over whatever the repo returned.
function hasMoneyShapedPayload(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasMoneyShapedPayload(v, depth + 1));
  for (const [key, nested] of Object.entries(value)) {
    if (MONEY_KEY_RE.test(key)) return true;
    if (hasMoneyShapedPayload(nested, depth + 1)) return true;
  }
  return false;
}

function carriesMoney(e: TimelineEvent): boolean {
  if (MONEY_SOURCES.has(e.source)) return true;
  if (MONEY_AUDIT_PREFIXES.some((p) => e.eventType.startsWith(p))) return true;
  return hasMoneyShapedPayload(e.payload);
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
  // 016 T030/T033 — actorRole widened to the full Role union (routes stop
  // casting); the member-redaction arm below keys on the literal 'member'.
  meta: { actorUserId: string; actorRole: Role; requestId: string },
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
      cause: rootCause(memberResult.error),
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
    // 016 post-ship review finding #2 — money exclusion must reach the SQL:
    // `total` is counted and the keyset cursor is built in the repo, so an
    // app-layer-only drop still disclosed money-event counts, billing
    // timestamps and invoice ref_ids through those two fields. `!== true`
    // so an absent dep fails CLOSED (same stance as the filter below).
    ...(deps.invoicingRead !== true ? { excludeMoney: true } : {}),
  };

  const timelineResult = await deps.timeline.listByMember(ctx, filter);

  if (!timelineResult.ok) {
    return err({
      type: 'server_error',
      message: 'Failed to load timeline',
      // Underlying error, not the RepoError wrapper (see member-verify branch
      // above) — keeps the routes' single `.cause` unwrap on a real Error so
      // `errKind` logs the actual class (e.g. NeonDbError), not 'unknown'.
      cause: rootCause(timelineResult.error),
    });
  }

  // 4. Redact for member-role callers (US6 AS3 / FR-017)
  const { events, nextCursor, total } = timelineResult.value;
  // rbac-portal-identity-ok: selects the member's own-history projection; the
  // permission decisions are the route gate above and `invoicingRead` below.
  const roleProjected = meta.actorRole === 'member' ? redactEvents(events) : events;
  // 016 review (security I-1) — money rows need `invoicing.read` on top of the
  // `members.read` that admitted the request. `!== true` rather than
  // `=== false` so an omitted dep fails CLOSED.
  const moneyFiltered =
    deps.invoicingRead !== true ? roleProjected.filter((e) => !carriesMoney(e)) : roleProjected;

  return ok({
    memberId,
    events: moneyFiltered,
    nextCursor,
    // 016 final review B2 + post-ship finding #2 — `total` is what the page
    // renders as its header count. Since `excludeMoney` reached the repo the
    // SQL COUNT and the cursor are already computed over the money-free set,
    // so for a money-excluded viewer this subtraction should be zero; it
    // remains as belt-and-braces for any residue the broader app-side probe
    // catches that the SQL twin somehow missed, so the header can never
    // disclose more than the rows on screen.
    total: Math.max(0, total - (roleProjected.length - moneyFiltered.length)),
  });
}
