/**
 * 124 — the plan ids and names of one plan year, soft-deleted plans included
 * (a deleted plan can still carry unpaid invoices). A lean read for surfaces
 * that only label a plan, such as the admin invoice list's `?plan=` chip:
 * unlike `listPlans` it reads no tax policy and computes no VAT.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { PlanRepo } from './ports';
import type { Plan, PlanYear } from '../domain/plan';

export type PlanNameItem = Pick<Plan, 'plan_id' | 'plan_name'>;

export type ListPlanNamesDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
};

export type ListPlanNamesError = { readonly type: 'server_error'; readonly message: string };

export async function listPlanNames(
  input: { readonly year: PlanYear },
  deps: ListPlanNamesDeps,
): Promise<Result<readonly PlanNameItem[], ListPlanNamesError>> {
  try {
    const plans = await deps.planRepo.findByTenantAndYear(deps.tenant, {
      year: input.year,
      showDeleted: true,
    });
    return ok(plans.map((p) => ({ plan_id: p.plan_id, plan_name: p.plan_name })));
  } catch (e) {
    return err({ type: 'server_error', message: e instanceof Error ? e.message : String(e) });
  }
}
