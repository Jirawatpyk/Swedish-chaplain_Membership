/**
 * `clone-plans-to-year` use case (T099, US2 FR-009).
 *
 * Admin clones the full non-deleted catalogue for `source_year`
 * into `target_year`. The flow is:
 *
 *   1. Guard `source_year !== target_year` (a 400-class input error).
 *   2. Delegate to `planRepo.cloneYear` — single transaction that
 *      (a) checks target-year emptiness, (b) bulk-inserts N copies,
 *      (c) returns a summary with the new plan IDs.
 *   3. Append one `plan_cloned` audit event (NOT N events) with the
 *      full list of new IDs — the audit volume stays manageable and
 *      the reconstruction story is "all-or-nothing".
 *   4. Return the summary envelope the API route serialises.
 *
 * Note: the repo already performs the target-year-populated + source-
 * year-empty checks atomically inside a single Postgres transaction,
 * so this use case has zero concurrency exposure beyond the repo's
 * own guard. A second concurrent clone race that slips past the
 * `count` check surfaces as a Postgres unique-violation, which the
 * repo's transaction rolls back cleanly.
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { recordAuditEvent } from './record-audit-event';
import type { PlanSlug, PlanYear } from '../domain/plan';

// --- Input / output types ---------------------------------------------------

export type ClonePlansToYearInput = {
  readonly sourceYear: PlanYear;
  readonly targetYear: PlanYear;
  readonly activateCloned: boolean;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type ClonePlansToYearSuccess = {
  readonly source_year: number;
  readonly target_year: number;
  readonly cloned_count: number;
  readonly cloned_plan_ids: ReadonlyArray<PlanSlug>;
};

export type ClonePlansToYearError =
  | { readonly type: 'invalid_body'; readonly message: string }
  | {
      readonly type: 'target_year_populated';
      readonly existing_count: number;
    }
  | { readonly type: 'source_year_empty' }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type ClonePlansToYearDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

// --- Implementation ---------------------------------------------------------

export async function clonePlansToYear(
  input: ClonePlansToYearInput,
  deps: ClonePlansToYearDeps,
): Promise<Result<ClonePlansToYearSuccess, ClonePlansToYearError>> {
  // 1. Source === target is an input error (matching contract § 9)
  if ((input.sourceYear as number) === (input.targetYear as number)) {
    return err({
      type: 'invalid_body',
      message: 'source_year and target_year must differ',
    });
  }

  // 2. Delegate to repo (handles all the transaction concerns)
  let cloneResult;
  try {
    cloneResult = await deps.planRepo.cloneYear(
      deps.tenant,
      input.sourceYear,
      input.targetYear,
      input.activateCloned,
      input.actorUserId,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!cloneResult.ok) {
    if (cloneResult.error.type === 'target_year_populated') {
      return err({
        type: 'target_year_populated',
        existing_count: cloneResult.error.existingCount,
      });
    }
    if (cloneResult.error.type === 'source_year_empty') {
      return err({ type: 'source_year_empty' });
    }
    // Exhaustiveness guard. If a future `CloneYearError` variant is
    // added without a handler above, the `never` narrowing fails
    // compile rather than producing the opaque `JSON.stringify(...)`
    // blob the old fallback emitted.
    const _exhaustive: never = cloneResult.error;
    return err({
      type: 'server_error',
      message: `unhandled clone error: ${JSON.stringify(_exhaustive)}`,
    });
  }

  const summary = cloneResult.value;

  // 3. Append one `plan_cloned` audit event for the whole batch
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_cloned',
      payload: {
        source_year: summary.sourceYear as number,
        target_year: summary.targetYear as number,
        plan_ids: [...summary.clonedPlanIds],
        count: summary.count,
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

  // 4. Return envelope
  return ok({
    source_year: summary.sourceYear as number,
    target_year: summary.targetYear as number,
    cloned_count: summary.count,
    cloned_plan_ids: summary.clonedPlanIds,
  });
}
