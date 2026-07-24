/**
 * Shared, pure parser for the /admin/members directory WHERE-shaping filter.
 *
 * Extracted so the two surfaces that must agree on "what does this filter
 * match" cannot drift:
 *   - the directory page (`src/app/(staff)/admin/members/page.tsx`) — renders
 *     the visible page + total count.
 *   - the select-all-matching ids endpoint (`src/app/api/members/ids/route.ts`)
 *     — resolves the SAME matching set so a bulk action can reach every match,
 *     not just the 50 visible rows (#2 members-ux).
 *
 * WHERE-shaping only: `sort`/`order` (presentation) and `limit`/`offset`
 * (pagination) are each caller's concern and are added on top of this result.
 * No framework imports — trivially unit-testable.
 */

/** Mirrors `MEMBER_STATUSES` (members domain) — the stable member lifecycle. */
export type MemberStatusFilter = 'active' | 'inactive' | 'archived';

/** Mirrors `RiskBand` (`modules/members/application/ports/member-repo.ts:18`). */
export type RiskBandValue = 'healthy' | 'warning' | 'at-risk' | 'critical';

/** The URL search-param subset that shapes the directory WHERE clause. */
export interface DirectoryFilterParams {
  readonly q?: string;
  readonly status?: string;
  readonly plan_id?: string;
  readonly show_archived?: string;
  readonly risk_band?: string;
  readonly portal?: string;
}

/** Normalised WHERE core — callers add `sort`/`order`/`limit`/`offset`. */
export interface ParsedDirectoryFilter {
  readonly q?: string;
  readonly planId?: string;
  readonly riskBand?: RiskBandValue | readonly RiskBandValue[];
  readonly status: readonly MemberStatusFilter[];
  /** Needs-invite chip (design doc 2026-07-23 §3.7). Caller wraps as `{ now }`. */
  readonly portalNeedsInvite: boolean;
  /**
   * Whether ANY filter narrows the default view. Drives the page's empty-state
   * choice (onboarding vs "no matches"). Not used by the ids endpoint.
   */
  readonly hasFilters: boolean;
}

const VALID_STATUSES = new Set<MemberStatusFilter>([
  'active',
  'inactive',
  'archived',
]);
const VALID_RISK_BANDS = new Set<RiskBandValue>([
  'healthy',
  'warning',
  'at-risk',
  'critical',
]);

/**
 * Allow-list for the needs-invite chip param. An unrecognised value is ignored
 * AND must not count as an active filter — otherwise `?portal=xyz` would render
 * the "no members match" state on a full directory.
 */
export function parsePortalFilter(raw: string | undefined): boolean {
  return raw === 'needs_invite';
}

/**
 * Sort allow-list (F9 FR-007a engagement + 055 member-number). Any other value
 * falls back to the repo's default recency order. Shared so the select-all-
 * matching ids endpoint orders its capped set the SAME way the visible page
 * does — otherwise, above the cap, the 100 selected would be default-ordered
 * while the admin sees their sorted view.
 */
export function parseDirectorySort(
  raw: string | undefined,
): 'engagement' | 'memberNumber' | undefined {
  return raw === 'engagement' || raw === 'memberNumber' ? raw : undefined;
}

export function parseDirectoryOrder(
  raw: string | undefined,
): 'asc' | 'desc' | undefined {
  return raw === 'asc' ? 'asc' : raw === 'desc' ? 'desc' : undefined;
}

export function parseDirectoryFilterFromParams(
  params: DirectoryFilterParams,
): ParsedDirectoryFilter {
  // Status — support the new ?status= param + the legacy ?show_archived=.
  let status: readonly MemberStatusFilter[];
  if (params.status && VALID_STATUSES.has(params.status as MemberStatusFilter)) {
    status = [params.status as MemberStatusFilter];
  } else if (params.show_archived === '1') {
    status = ['active', 'inactive', 'archived'];
  } else {
    status = ['active', 'inactive'];
  }

  // Risk band — accept a comma-separated list (the dashboard "needs attention"
  // KPI drills into critical,at-risk,warning so the count matches). Each value
  // is validated; a single value stays scalar.
  const riskBandList = (params.risk_band ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b): b is RiskBandValue => VALID_RISK_BANDS.has(b as RiskBandValue));
  const riskBand: RiskBandValue | readonly RiskBandValue[] | undefined =
    riskBandList.length === 0
      ? undefined
      : riskBandList.length === 1
        ? riskBandList[0]
        : riskBandList;

  const portalNeedsInvite = parsePortalFilter(params.portal);
  const q = params.q?.trim() ? params.q.trim() : undefined;
  const planId =
    params.plan_id && params.plan_id !== 'all' ? params.plan_id : undefined;

  const hasFilters =
    q !== undefined ||
    (params.status !== undefined && params.status !== 'all') ||
    (params.plan_id !== undefined && params.plan_id !== 'all') ||
    params.show_archived === '1' ||
    riskBand !== undefined ||
    portalNeedsInvite;

  return {
    ...(q !== undefined ? { q } : {}),
    ...(planId !== undefined ? { planId } : {}),
    ...(riskBand !== undefined ? { riskBand } : {}),
    status,
    portalNeedsInvite,
    hasFilters,
  };
}
