/**
 * `deactivate-plan` use case (T128, US4 FR-009).
 *
 * Thin wrapper around `setPlanActive(input, deps, false)`. Provides
 * the distinct input/error/deps types so contract tests and route
 * handlers can import `DeactivatePlanInput` etc. without knowing the
 * shared helper.
 *
 * See `set-plan-active.ts` for the full flow (state machine guard,
 * idempotent no-op, audit-as-use-case-failure).
 */

import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { setPlanActive } from './set-plan-active';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';

export type DeactivatePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
};

export type DeactivatePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type DeactivatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function deactivatePlan(
  input: DeactivatePlanInput,
  deps: DeactivatePlanDeps,
): Promise<Result<Plan, DeactivatePlanError>> {
  return setPlanActive(input, deps, false);
}
