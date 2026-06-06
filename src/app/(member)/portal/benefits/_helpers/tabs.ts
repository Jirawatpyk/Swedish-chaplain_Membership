/**
 * 058 G1 — Benefits page tab identity (spec §4.4).
 *
 * The active tab is driven by the `?tab=` URL search param so deep-link /
 * back-button / share work. This pure helper maps the raw param onto the
 * closed tab union (default = benefits, unknown clamps to benefits). Kept
 * framework-free so it unit-tests without rendering.
 */
export const BENEFITS_TAB = {
  benefits: 'benefits',
  broadcasts: 'broadcasts',
} as const;

export type BenefitsTab = (typeof BENEFITS_TAB)[keyof typeof BENEFITS_TAB];

export function resolveBenefitsTab(raw: string | undefined): BenefitsTab {
  return raw === BENEFITS_TAB.broadcasts ? BENEFITS_TAB.broadcasts : BENEFITS_TAB.benefits;
}
