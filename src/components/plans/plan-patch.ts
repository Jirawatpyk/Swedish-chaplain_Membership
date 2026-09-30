/**
 * Sparse PATCH payload for the plan edit page, plus its client-side check.
 *
 * `computePlanPatch` diffs the draft against the loaded plan so only changed
 * fields are sent — this keeps the audit log's diff honest (no phantom no-op
 * writes). `planPatchFieldErrors` runs that same patch through
 * `planPatchSchema` (what `PATCH /api/plans/[year]/[planId]` validates) and
 * maps the issues to the wizard's per-field message keys.
 */
import { planPatchSchema, type PlanSchemaInput } from '@/modules/plans';
import { fieldErrorsFromIssues, type PlanFormFieldErrors } from './plan-form-errors';

export function computePlanPatch(
  initial: PlanSchemaInput,
  draft: PlanSchemaInput,
): Partial<PlanSchemaInput> {
  const patch: Record<string, unknown> = {};
  const keys = Object.keys(draft) as Array<keyof PlanSchemaInput>;
  for (const key of keys) {
    // plan_id + plan_year are identity keys, never patched
    if (key === 'plan_id' || key === 'plan_year') continue;
    const before = initial[key];
    const after = draft[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[key] = after;
    }
  }
  return patch as Partial<PlanSchemaInput>;
}

/**
 * One message key per invalid field of `patch`. Empty when it passes
 * `planPatchSchema`. `planCategory` is the plan's (draft) category, which
 * picks the bundle message.
 */
export function planPatchFieldErrors(
  patch: Partial<PlanSchemaInput>,
  planCategory: PlanSchemaInput['plan_category'],
): PlanFormFieldErrors {
  const parsed = planPatchSchema.safeParse(patch);
  if (parsed.success) return {};
  return fieldErrorsFromIssues(parsed.error.issues, planCategory);
}
