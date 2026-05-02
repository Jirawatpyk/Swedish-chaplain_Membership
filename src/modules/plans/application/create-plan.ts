/**
 * `create-plan` use case (T098, US2 FR-007).
 *
 * Admin creates a brand-new plan (not a clone) with a full benefit
 * matrix. The flow:
 *
 *   1. Validate the raw input through `planSchema` — returns
 *      `invalid_body` or `partnership_corporate_mismatch` on failure
 *      (the superRefine integrity rules land in the 422 bucket
 *      because they fire on cross-field inconsistency, not shape).
 *   2. Call `planRepo.findOne` to detect duplicates on composite key
 *      — catches the race pre-insert so the client gets a clean
 *      409 `duplicate_plan` instead of a Postgres unique-violation
 *      surfacing as a 500.
 *   3. Insert the plan via `planRepo.insert` with `is_active = false`
 *      by default (AS1: newly created plans start inactive).
 *   4. Append a `plan_created` audit event with the full payload.
 *   5. Return the created `Plan`.
 *
 * **Audit-as-use-case-failure**: per `record-audit-event.ts`, an
 * audit write failure MUST propagate as a use-case failure. The F2
 * audit trail is a compliance artefact — silently swallowing a
 * failed write would corrupt the log. If the audit write fails
 * AFTER the plan insert succeeded, we still return an error to the
 * caller; the operator sees both the log row and the API error, and
 * a cleanup job (or manual retry) re-appends the missing audit
 * entry. The alternative — rolling back the insert on audit failure
 * — was rejected because it couples Application code to the
 * transaction boundary in ways that Principle III forbids.
 *
 * Pure Application logic — no Drizzle, no Next, no React imports.
 */

import { err, ok, type Result } from '@/lib/result';
import { errorChainMessage, isUniqueViolation } from '@/lib/db-errors';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
  MemberAttachmentChecker,
  PlanDraftInput,
  PlanRepo,
} from './ports';
import { recordAuditEvent } from './record-audit-event';
import { classifyZodIssues } from './classify-zod-issues';
import {
  asPlanSlug,
  asPlanYear,
  type Plan,
} from '../domain/plan';
import {
  planSchema,
  type PlanSchemaInput,
} from '../domain/plan-validators';

export type CreatePlanInput = {
  readonly input: PlanSchemaInput;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type CreatePlanError =
  | {
      readonly type: 'invalid_body';
      readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    }
  | {
      readonly type: 'partnership_corporate_mismatch';
      readonly issues: ReadonlyArray<string>;
    }
  | { readonly type: 'duplicate_plan' }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type CreatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function createPlan(
  input: CreatePlanInput,
  deps: CreatePlanDeps,
): Promise<Result<Plan, CreatePlanError>> {
  // 1. Validate shape + integrity
  const parsed = planSchema.safeParse(input.input);
  if (!parsed.success) {
    const classified = classifyZodIssues(parsed.error.issues);
    if (classified.kind === 'integrity') {
      return err({
        type: 'partnership_corporate_mismatch',
        issues: classified.details,
      });
    }
    return err({ type: 'invalid_body', issues: classified.details });
  }

  const draft = parsed.data;
  const planId = asPlanSlug(draft.plan_id);
  const planYear = asPlanYear(draft.plan_year);

  // 2. Duplicate-key pre-check via findOne (RLS-scoped)
  try {
    const existing = await deps.planRepo.findOne(deps.tenant, planId, planYear);
    if (existing) {
      return err({ type: 'duplicate_plan' });
    }
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Insert — is_active defaults to false per AS1
  const planDraft: PlanDraftInput = {
    ...draft,
    isActive: false,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
  };

  let created: Plan;
  try {
    created = await deps.planRepo.insert(deps.tenant, planDraft);
  } catch (e) {
    // Pg unique-violation raced past findOne — surface as duplicate_plan
    const msg = errorChainMessage(e);
    if (
      isUniqueViolation(e) ||
      /duplicate key value|unique constraint/i.test(msg)
    ) {
      return err({ type: 'duplicate_plan' });
    }
    return err({ type: 'server_error', message: msg });
  }

  // 4. Append audit event — audit failure is a use-case failure
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_created',
      payload: {
        plan_id: planId,
        plan_year: planYear,
        plan_name_en: draft.plan_name.en,
        annual_fee_minor_units: draft.annual_fee_minor_units,
        category: draft.plan_category,
        member_type_scope: draft.member_type_scope,
      },
    },
  );
  if (!auditResult.ok) {
    return err({
      type: 'audit_failed',
      message:
        auditResult.error.type === 'invalid_payload'
          ? auditResult.error.issues.join('; ')
          : auditResult.error.message,
    });
  }

  return ok(created);
}
