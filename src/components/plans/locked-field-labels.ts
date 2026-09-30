/**
 * Form labels for the fields a prior-year plan locks, so the
 * `prior_year_locked_fields` toast names them the way the form does rather
 * than by their API keys. Keys resolve under `admin.plans.create.labels`.
 */
import type { LockedField } from '@/modules/plans';

export const LOCKED_FIELD_LABEL_KEYS = {
  annual_fee_minor_units: 'annualFee',
  min_turnover_minor_units: 'minTurnover',
  max_turnover_minor_units: 'maxTurnover',
  max_duration_years: 'maxDurationYears',
  max_member_age: 'maxMemberAge',
  member_type_scope: 'memberTypeScope',
  includes_corporate_plan_id: 'includesCorporatePlanId',
  benefit_matrix: 'benefitMatrix',
} as const satisfies Record<LockedField, string>;

type LockedFieldLabelKey = (typeof LOCKED_FIELD_LABEL_KEYS)[LockedField];

function isLockedField(value: string): value is LockedField {
  return Object.hasOwn(LOCKED_FIELD_LABEL_KEYS, value);
}

/**
 * Labels for `fields` (the untrusted `error.details.locked_fields` from the
 * API). A key this client doesn't know yet is shown as-is rather than
 * silently dropped; anything that isn't a string is ignored.
 */
export function lockedFieldLabels(
  fields: unknown,
  t: (key: LockedFieldLabelKey) => string,
): string[] {
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f): f is string => typeof f === 'string')
    .map((f) => (isLockedField(f) ? t(LOCKED_FIELD_LABEL_KEYS[f]) : f));
}
