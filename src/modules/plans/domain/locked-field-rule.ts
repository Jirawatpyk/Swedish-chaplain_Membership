/**
 * Prior-year partial-lock rule (FR-014, Clarifications Q4).
 *
 * When a plan's `plan_year` is **less than** the current year, certain
 * "load-bearing" fields become frozen — editing them would retroactively
 * change what members who signed up under the historical plan received,
 * which breaks audit, invoicing, and regulatory integrity. Cosmetic
 * fields (display name, description, sort order) remain editable so
 * admins can still fix typos on archived rows.
 *
 * Current-year plans (and future-year plans created by `clone-year`)
 * have NO fields locked — every field is editable.
 *
 * See data-model.md § 3 and research.md § 8 for the full rationale.
 * Pure TypeScript — no framework imports.
 */

import type { Plan } from './plan';

/**
 * The exact list of fields frozen on prior-year plans. Sourced from
 * data-model.md — DO NOT edit without updating the spec + test.
 */
export const LOCKED_FIELDS_ON_PRIOR_YEAR = [
  'annual_fee_minor_units',
  'min_turnover_minor_units',
  'max_turnover_minor_units',
  'max_duration_years',
  'max_member_age',
  'member_type_scope',
  'includes_corporate_plan_id',
  'benefit_matrix',
] as const satisfies ReadonlyArray<keyof Plan>;

export type LockedField = (typeof LOCKED_FIELDS_ON_PRIOR_YEAR)[number];

/**
 * Given an existing Plan, a partial patch, and the current year,
 * return the list of locked fields that the patch is trying to change
 * on a prior-year plan.
 *
 * Returns an empty array when:
 *   - `plan.plan_year >= currentYear` (not a prior year — nothing locked)
 *   - the patch does not touch any locked field
 *   - the patch touches a locked field but the new value is deeply equal
 *     to the existing value (no-op writes are safe)
 *
 * The caller (use case `update-plan.ts`) maps a non-empty result to a
 * `422 prior_year_locked_fields` error with `details.locked_fields =
 * [...]` + `suggested_action: 'clone_to_current_year'`.
 */
export function detectLockedFieldChanges(
  plan: Plan,
  patch: Partial<Plan>,
  currentYear: number,
): LockedField[] {
  // Current year or future — no locks apply
  if (plan.plan_year >= currentYear) {
    return [];
  }

  const changed: LockedField[] = [];
  for (const field of LOCKED_FIELDS_ON_PRIOR_YEAR) {
    if (!(field in patch)) continue;
    const oldValue = plan[field];
    const newValue = patch[field];
    if (!deepEqual(oldValue, newValue)) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Minimal structural equality check. Sufficient for the value types
 * that appear in `LOCKED_FIELDS_ON_PRIOR_YEAR`: numbers, strings,
 * booleans, nulls, and the `BenefitMatrix` JSONB object.
 *
 * Not exported — the rule is the only caller.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}
