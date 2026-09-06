/**
 * 108 PR-D (FR-035, FR-035b, FR-027a) — URL search params → Marketing
 * audience filter, in one allow-listed place (mirrors
 * `members-directory-filter.ts`).
 *
 * A query string can only ever NARROW the view: unknown `kind` / `state`
 * values are dropped, `member_id` must be a UUID, `eligible` defaults to ON
 * (the spec's default view) and is lifted only by an explicit `0` / `false`,
 * `page` clamps to ≥ 1 AND to `MARKETING_AUDIENCE_MAX_PAGE`. `hasFilters` drives the "no matches → clear filters"
 * empty state, so a stray `?state=banana` renders the full audience, not an
 * empty page.
 *
 * URL vocabulary is the contract § 3 one (`off_staff` / `off_contact`); the
 * Domain vocabulary (`off_by_staff` / `off_by_contact`) never leaks into a
 * URL, so renaming either side is a one-line change here.
 */
// TYPE-ONLY imports on purpose: this module is imported by the CLIENT filter
// bar (`audience-filters.tsx`), and a value import from the members barrel
// would drag the Drizzle repos (and, through them, the payments
// infrastructure) into the browser bundle — the 066 barrel-cycle class,
// which surfaced as an "Uncaught Error" in the T047 e2e on the first run.
// `memberId` is branded with a cast after the UUID check below instead.
import type {
  MarketingAudienceFilter,
  MarketingAudienceStateFilter,
  MemberId,
} from '@/modules/members';

/**
 * The id of the count line on the audience page. It lives HERE, not in the
 * `'use client'` switch that focuses it (review code L1): a Server Component
 * importing a value from a client module receives a client-reference proxy,
 * which only worked because the page passed it straight through as a prop —
 * `String(...)` or a template literal would have thrown.
 */
export const AUDIENCE_COUNT_ID = 'audience-count';

/** Upper clamp for `?page` (security LOW-4) — far beyond any real tenant. */
export const MARKETING_AUDIENCE_MAX_PAGE = 100_000;

export type MarketingAudienceSearchParams = Readonly<
  Record<string, string | string[] | undefined>
>;

/** The FR-027a pre-flight preset: secondaries that will newly receive. */
export const MARKETING_AUDIENCE_PREFLIGHT_QUERY = 'kind=secondary&state=on&eligible=1';

export const MARKETING_AUDIENCE_STATE_PARAMS = [
  'on',
  'off_staff',
  'off_contact',
  'unsubscribed',
] as const;
export type MarketingAudienceStateParam = (typeof MARKETING_AUDIENCE_STATE_PARAMS)[number];

const STATE_BY_PARAM: Readonly<Record<MarketingAudienceStateParam, MarketingAudienceStateFilter>> = {
  on: 'on',
  off_staff: 'off_by_staff',
  off_contact: 'off_by_contact',
  unsubscribed: 'unsubscribed',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Same cap as the members directory search box. */
const Q_MAX_LENGTH = 100;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface ParsedMarketingAudienceParams {
  readonly filter: MarketingAudienceFilter;
  readonly page: number;
  /** True when the USER set a filter (incl. `eligible=0`) — drives "Clear filters". */
  readonly hasFilters: boolean;
  /**
   * True when the result is a SUBSET of the tenant's contacts — `hasFilters`
   * plus the default `eligible=on` leg. Drives the count copy and which empty
   * state is honest (review code M1).
   */
  readonly narrowed: boolean;
}

export function parseMarketingAudienceParams(
  params: MarketingAudienceSearchParams,
): ParsedMarketingAudienceParams {
  const rawQ = first(params.q)?.trim() ?? '';
  const q = rawQ.length > 0 ? rawQ.slice(0, Q_MAX_LENGTH) : undefined;

  const rawMember = first(params.member_id);
  const memberId =
    rawMember !== undefined && UUID_RE.test(rawMember)
      ? (rawMember.toLowerCase() as MemberId)
      : undefined;

  const rawKind = first(params.kind);
  const kind = rawKind === 'primary' || rawKind === 'secondary' ? rawKind : undefined;

  const rawState = first(params.state);
  const state =
    rawState !== undefined &&
    (MARKETING_AUDIENCE_STATE_PARAMS as readonly string[]).includes(rawState)
      ? STATE_BY_PARAM[rawState as MarketingAudienceStateParam]
      : undefined;

  const rawEligible = first(params.eligible);
  const eligible = !(rawEligible === '0' || rawEligible === 'false');

  const rawPage = Number.parseInt(first(params.page) ?? '', 10);
  // Clamped BOTH ways (security review LOW-4): `?page=1e20` would otherwise
  // become an OFFSET beyond bigint and a free COUNT(*) amplifier for any
  // `contacts.read` holder.
  const page =
    Number.isFinite(rawPage) && rawPage >= 1
      ? Math.min(rawPage, MARKETING_AUDIENCE_MAX_PAGE)
      : 1;

  const hasFilters =
    q !== undefined ||
    memberId !== undefined ||
    kind !== undefined ||
    state !== undefined ||
    !eligible;

  // `eligible=on` is the DEFAULT, so it is not a filter the USER set — but it
  // does narrow the query (member active, not erased, not halted). A tenant
  // whose members are all inactive or archived would otherwise be told "No
  // contacts yet" with no Clear-filters way back, and the count line would
  // claim a total that is not the tenant's total (review code M1).
  const narrowed =
    eligible ||
    q !== undefined ||
    memberId !== undefined ||
    kind !== undefined ||
    state !== undefined;

  return {
    filter: {
      ...(q !== undefined ? { q } : {}),
      ...(memberId !== undefined ? { memberId } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(state !== undefined ? { state } : {}),
      eligible,
    },
    page,
    hasFilters,
    narrowed,
  };
}
