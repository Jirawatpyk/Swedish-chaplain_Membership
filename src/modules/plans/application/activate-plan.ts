/**
 * `activate-plan` use case (T127, US4 FR-009).
 *
 * Thin wrapper around `setPlanActive(input, deps, true)`. Provides
 * the distinct input/error/deps types so contract tests and route
 * handlers can import `ActivatePlanInput` etc. without knowing the
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
  FeeConfigRepo,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { setPlanActive } from './set-plan-active';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';

export type ActivatePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
};

export type ActivatePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type ActivatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function activatePlan(
  input: ActivatePlanInput,
  deps: ActivatePlanDeps,
): Promise<Result<Plan, ActivatePlanError>> {
  return setPlanActive(input, deps, true);
}
