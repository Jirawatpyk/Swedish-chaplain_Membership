/**
 * WP7 — plan-change summary + fee formatting for the admin member-edit
 * confirm dialog (BP3 + correction C-16).
 *
 * An admin could previously change a member's plan (e.g. Premium → Regular)
 * and have it save silently — the picker showed only a name and the only
 * confirmations were server-triggered escalations (409 bundle / 422 override).
 * This builds the old→new plan + fee summary the unconditional confirm dialog
 * renders.
 *
 * Pure module (no React / next-intl) so it is unit-testable without a render.
 */
import { formatSatangThb } from '@/lib/format-thb';
import type { PlanOption } from './member-form/schema';

/**
 * Whether a manual member-edit plan change automatically flows into renewal
 * billing.
 *
 * **true** since the plan-change → billing remediation: `changePlan` flips
 * `members.plan_id` immediately and the next-cycle seed
 * (`create-next-cycle-on-paid.ts` + `resolve-unlinked-membership-payment.ts`)
 * now reads `members.plan_id`, so every renewal cycle created AFTER the change
 * bills the new plan automatically — no separate renewal-cycle edit needed.
 *
 * Scope note the dialog copy must respect: this is a FUTURE-cycles guarantee,
 * not an immediate one. The current open cycle keeps its frozen (old) price
 * until it rolls over — an already-issued §86/4 is never rewritten (immediate
 * mid-cycle re-freeze is the deferred, flag-gated Phase 2). Hence the note
 * reads "future renewal cycles", NOT "the next invoice".
 */
export const PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL = true;

export interface PlanChangeSummary {
  readonly oldPlanId: string;
  readonly oldPlanYear: number;
  readonly newPlanId: string;
  readonly newPlanYear: number;
  /** Resolved display name; falls back to the slug for an absent (prior-year/inactive) plan. */
  readonly oldPlanLabel: string;
  readonly newPlanLabel: string;
  /** Annual fee in currency minor units; null when the plan is absent from the picker list. */
  readonly oldFeeMinorUnits: number | null;
  readonly newFeeMinorUnits: number | null;
  /** Tenant currency for the fees; null only when NEITHER plan resolved. */
  readonly currencyCode: string | null;
  /** Only the plan_year changed; the plan itself is identical. */
  readonly yearOnly: boolean;
}

/**
 * Build the old→new plan-change summary.
 *
 * Matches each plan on the **(plan_id, plan_year)** pair — `display_name`
 * embeds the year and the same id recurs across years, so an id-only lookup
 * would fabricate the wrong-year fee on a money screen (C-16). A plan absent
 * from `plans` (inactive / prior-year — the edit page loads `activeOnly`)
 * legitimately falls back to the slug + a null fee.
 */
export function buildPlanChangeSummary(
  plans: readonly PlanOption[],
  oldPlanId: string,
  oldPlanYear: number,
  newPlanId: string,
  newPlanYear: number,
): PlanChangeSummary {
  const oldOption = plans.find(
    (p) => p.plan_id === oldPlanId && p.plan_year === oldPlanYear,
  );
  const newOption = plans.find(
    (p) => p.plan_id === newPlanId && p.plan_year === newPlanYear,
  );
  return {
    oldPlanId,
    oldPlanYear,
    newPlanId,
    newPlanYear,
    oldPlanLabel: oldOption?.display_name ?? oldPlanId,
    newPlanLabel: newOption?.display_name ?? newPlanId,
    oldFeeMinorUnits: oldOption?.annual_fee_minor_units ?? null,
    newFeeMinorUnits: newOption?.annual_fee_minor_units ?? null,
    currencyCode: newOption?.currency_code ?? oldOption?.currency_code ?? null,
    yearOnly: oldPlanId === newPlanId && oldPlanYear !== newPlanYear,
  };
}

/**
 * Format an annual fee (currency minor units) as a suffixed THB-style string
 * (e.g. `"36,000.00 THB"`). `0` is a valid fee (`"0.00 THB"`), never em-dash.
 * A non-integer minor-units value (which `BigInt()` would throw on) degrades
 * to em-dash rather than crashing the dialog.
 */
export function formatPlanFee(
  minorUnits: number,
  locale: string,
  currencyCode: string,
): string {
  if (!Number.isInteger(minorUnits)) return '—';
  return formatSatangThb(BigInt(minorUnits), locale, currencyCode);
}
