/**
 * Task #12 — the category names a tier E-Blast's history row shows, shared by
 * the member panel and its preview fixture so the two cannot drift.
 *
 * Tier codes are free text the member typed (stored as `segmentParams.tierCodes`).
 * Only the two `plan_category` values are looked up: a next-intl `has()` is
 * true for Object.prototype names such as `constructor`, which would print a
 * key path. Anything else shows as typed, so a code that matched nobody is
 * not dressed up as a category. A repeated code is named once.
 */
export type PlanCategoryCode = 'corporate' | 'partnership';

const PLAN_CATEGORY_CODES: ReadonlySet<string> = new Set<PlanCategoryCode>(['corporate', 'partnership']);

function isPlanCategoryCode(code: string): code is PlanCategoryCode {
  return PLAN_CATEGORY_CODES.has(code);
}

/** "Corporate and Partnership" / "องค์กรและพันธมิตร": the members of either category. */
export function tierNames(
  codes: ReadonlyArray<string>,
  locale: string,
  label: (code: PlanCategoryCode) => string,
): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(
    [...new Set(codes)].map((code) => (isPlanCategoryCode(code) ? label(code) : code)),
  );
}
