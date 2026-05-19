/**
 * `get-plan` use case (T073, US1 + US3).
 *
 * Loads a single plan by composite key via `planRepo.findOne`. Returns
 * `not_found` when the plan doesn't exist OR belongs to a different
 * tenant (RLS transparently filters it out). Appends a
 * `plan_not_found` audit event on every 404 per critique E6 + data-
 * model.md § 2.6a. Request-path code NEVER runs a BYPASS RLS query to
 * distinguish innocent typos from cross-tenant probes — the F13
 * periodic scan correlates events offline and escalates to
 * `plan_cross_tenant_probe`.
 */

import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort, PlanRepo } from './ports';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';

export type GetPlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
};

export type GetPlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'server_error'; readonly message: string };

export type GetPlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly method: 'GET' | 'PATCH' | 'DELETE' | 'POST';
  readonly route: string;
};

export async function getPlan(
  input: GetPlanInput,
  deps: GetPlanDeps,
): Promise<Result<Plan, GetPlanError>> {
  let plan: Plan | undefined;
  try {
    plan = await deps.planRepo.findOne(
      deps.tenant,
      input.planId,
      input.year,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!plan) {
    // 404 never 403: log the request-path audit event so the future
    // F13 scan can correlate. This is info severity by design — the
    // scan escalates to 'high' only when cross-tenant match is found.
    // Audit failure on a read-path 404 is non-fatal but surfaces a
    // compliance gap for on-call awareness.
    const auditResult = await deps.audit.record(
      {
        tenant: deps.tenant,
        actorUserId: deps.actorUserId,
        requestId: deps.requestId,
        sourceIp: deps.sourceIp,
      },
      {
        event_type: 'plan_not_found',
        payload: {
          requested_plan_id: input.planId,
          requested_year: input.year,
          method: deps.method,
          route: deps.route,
        },
      },
    );
    // Audit failure on a read-path 404 is non-fatal but is forensically
    // load-bearing: F13's correlation scanner consumes `plan_not_found`
    // rows to escalate cross-tenant probes to `plan_cross_tenant_probe`.
    // A sustained `persist_failed` (audit_log RLS drift, immutable
    // trigger regression, DB flap) silently disables the F13 pipeline
    // unless we log it — emit a structured error so on-call dashboards
    // can alert before the security event is lost.
    if (!auditResult.ok) {
      logger.error(
        {
          event: 'plan_not_found_audit_failed',
          tenant: deps.tenant.slug,
          plan_id: input.planId,
          plan_year: input.year as number,
          actor_user_id: deps.actorUserId,
          request_id: deps.requestId,
          err:
            auditResult.error.type === 'invalid_payload'
              ? { type: 'invalid_payload', issues: auditResult.error.issues }
              : { type: 'persist_failed', message: auditResult.error.message },
        },
        'get-plan: audit record persist_failed — F13 cross-tenant-probe correlation pipeline at risk',
      );
    }
    return err({ type: 'not_found' });
  }

  return ok(plan);
}
