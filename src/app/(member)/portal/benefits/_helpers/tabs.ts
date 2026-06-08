/**
 * 058 G1 — Benefits page tab identity + pagination clamp (spec §4.4).
 *
 * The active tab is driven by the `?tab=` URL search param so deep-link /
 * back-button / share work. These pure helpers map the raw params onto the
 * closed tab union (default = benefits, unknown clamps to benefits) and onto a
 * safe [1, 1000] page integer. Kept framework-free so they unit-test without
 * rendering, and so they are the SINGLE canonical clamp shared by the Next
 * searchParams reader (page.tsx) AND the Base UI Tabs `onValueChange`
 * (benefits-tabs.tsx) — neither hand-rolls its own narrowing.
 */
export const BENEFITS_TAB = {
  benefits: 'benefits',
  broadcasts: 'broadcasts',
} as const;

export type BenefitsTab = (typeof BENEFITS_TAB)[keyof typeof BENEFITS_TAB];

/**
 * Canonical clamp for the benefits tab identity. Accepts `unknown` so it is the
 * single source of truth for BOTH Next searchParams (`string | string[] |
 * undefined`) and the Base UI Tabs `onValueChange` value (typed `any`). Only an
 * exact `'broadcasts'` string selects the broadcasts tab; everything else
 * (missing, unknown string, array, number, …) clamps to the default benefits
 * tab. The strict `===` compare is safe on `unknown`.
 */
export function resolveBenefitsTab(raw: unknown): BenefitsTab {
  return raw === BENEFITS_TAB.broadcasts ? BENEFITS_TAB.broadcasts : BENEFITS_TAB.benefits;
}

/** Lower bound for the broadcast-tab pagination page (1-indexed). */
const MIN_BENEFITS_PAGE = 1;
/** Upper bound for the broadcast-tab pagination page (defence against a
 *  hand-crafted `?page=99999` driving an out-of-range DB offset; the panel
 *  derives totalPages and renders the empty-state past the last page). */
const MAX_BENEFITS_PAGE = 1_000;

/**
 * Canonical clamp for the broadcast-tab `?page=` param. Parses `raw` to a
 * number, floors fractionals, and clamps to [1, 1000]. Any non-numeric /
 * NaN / missing / non-finite input falls back to 1. This is the single
 * source of truth for the page bound — the BroadcastsPanel re-clamps
 * defensively but never needs to re-derive the parse rule.
 *
 * @example clampBenefitsPage('5')      // 5
 * @example clampBenefitsPage(2.9)      // 2
 * @example clampBenefitsPage(-5)       // 1
 * @example clampBenefitsPage(99999)    // 1000
 * @example clampBenefitsPage('abc')    // 1
 * @example clampBenefitsPage(undefined)// 1
 */
export function clampBenefitsPage(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MIN_BENEFITS_PAGE;
  const floored = Math.floor(parsed);
  return Math.min(MAX_BENEFITS_PAGE, Math.max(MIN_BENEFITS_PAGE, floored));
}
