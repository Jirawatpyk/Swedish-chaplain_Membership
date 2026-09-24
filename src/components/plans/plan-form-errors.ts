/**
 * Per-field error mapping for the plan wizard.
 *
 * Runs the authoritative `planSchema` (shape + the cross-field rules in
 * `plan-validators.ts`: min < max turnover, a partnership plan bundles a
 * corporate plan and carries the partnership matrix, a corporate plan does
 * neither) and turns its issues into one message key per form field, plus
 * the wizard step that renders that field. The keys resolve under
 * `admin.plans.create.fieldErrors`.
 *
 * Messages are keyed by field + rule rather than read from zod: the schema's
 * messages are English developer strings.
 */
import { planSchema, type PlanSchemaInput } from '@/modules/plans';

export type PlanFormStep = 'basics' | 'fees' | 'benefits';

export type PlanFormField =
  | 'plan_id'
  | 'plan_year'
  | 'plan_name'
  | 'description'
  | 'sort_order'
  | 'plan_category'
  | 'member_type_scope'
  | 'annual_fee_minor_units'
  | 'min_turnover_minor_units'
  | 'max_turnover_minor_units'
  | 'max_duration_years'
  | 'max_member_age'
  | 'includes_corporate_plan_id'
  | 'benefit_matrix';

export type PlanFormErrorKey =
  | 'planId'
  | 'planYear'
  | 'planName'
  | 'description'
  | 'sortOrder'
  | 'invalidOption'
  | 'annualFee'
  | 'amount'
  | 'turnoverOrder'
  | 'maxDurationYears'
  | 'maxMemberAge'
  | 'bundleRequired'
  | 'bundleNotAllowed'
  | 'bundleInvalid'
  | 'partnershipBenefits'
  | 'benefitMatrix';

export type PlanFormFieldErrors = Partial<Record<PlanFormField, PlanFormErrorKey>>;

const FEES_FIELDS: ReadonlySet<PlanFormField> = new Set([
  'annual_fee_minor_units',
  'min_turnover_minor_units',
  'max_turnover_minor_units',
  'max_duration_years',
  'max_member_age',
  'includes_corporate_plan_id',
]);

/** The wizard step that renders `field`. */
export function planFieldStep(field: PlanFormField): PlanFormStep {
  if (field === 'benefit_matrix') return 'benefits';
  if (FEES_FIELDS.has(field)) return 'fees';
  return 'basics';
}

const SIMPLE_KEYS: Record<PlanFormField, PlanFormErrorKey> = {
  plan_id: 'planId',
  plan_year: 'planYear',
  plan_name: 'planName',
  description: 'description',
  sort_order: 'sortOrder',
  plan_category: 'invalidOption',
  member_type_scope: 'invalidOption',
  annual_fee_minor_units: 'annualFee',
  min_turnover_minor_units: 'amount',
  max_turnover_minor_units: 'amount',
  max_duration_years: 'maxDurationYears',
  max_member_age: 'maxMemberAge',
  includes_corporate_plan_id: 'bundleInvalid',
  benefit_matrix: 'benefitMatrix',
};

function isPlanFormField(value: PropertyKey | undefined): value is PlanFormField {
  return typeof value === 'string' && value in SIMPLE_KEYS;
}

/**
 * One message key per invalid field (the first issue wins). Empty when the
 * draft passes `planSchema`.
 */
export function planFormFieldErrors(draft: PlanSchemaInput): PlanFormFieldErrors {
  const parsed = planSchema.safeParse(draft);
  if (parsed.success) return {};

  const errors: PlanFormFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (!isPlanFormField(field) || errors[field] !== undefined) continue;
    const crossField = issue.code === 'custom';

    if (field === 'includes_corporate_plan_id' && crossField) {
      errors[field] =
        draft.plan_category === 'partnership' ? 'bundleRequired' : 'bundleNotAllowed';
    } else if (field === 'max_turnover_minor_units' && crossField) {
      errors[field] = 'turnoverOrder';
    } else if (
      field === 'benefit_matrix' &&
      crossField &&
      issue.path[1] === 'partnership'
    ) {
      errors[field] = 'partnershipBenefits';
    } else {
      errors[field] = SIMPLE_KEYS[field];
    }
  }
  return errors;
}
