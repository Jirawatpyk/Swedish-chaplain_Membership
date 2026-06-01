/**
 * `bulk-action` use case (T104, US4 FR-018/019/019a/019b).
 *
 * Applies a bulk action (change_plan, archive) to ≤100 members in a
 * single all-or-nothing transaction. (send_portal_invite moved to the
 * dedicated `bulkSendPortalInvite` use case — go-live P1-17 — because
 * invites are best-effort per member + run in F1's owner-role tx, which
 * cannot join this all-or-nothing runInTenant.) Per-actor rate
 * limit of 10 ops / 10 min is enforced at the ROUTE HANDLER (not here
 * — use case is a single point of truth for business logic; rate limit
 * is a transport-layer concern that lives in Presentation — round-2
 * review C-1).
 *
 * Each affected member produces one audit event; the entire batch
 * commits or rolls back atomically (FR-019 — no partial state).
 *
 * `change_plan` validates plan tenant ownership via PlanLookupPort
 * before assignment (round-2 review I-5 — prevents cross-tenant plan
 * assignment, Principle I violation).
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  archive,
  asMemberId,
  asPlanId,
} from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { PlanLookupPort } from '../ports/plan-lookup-port';

// --- Constants ---------------------------------------------------------------

export const BULK_CAP = 100;
export const BULK_RATE_MAX = 10;
export const BULK_RATE_WINDOW_SECONDS = 600; // 10 minutes

// --- Input schema ------------------------------------------------------------
//
// `.superRefine()` enforces that `change_plan` always carries both
// `new_plan_id` AND `new_plan_year` together (round-2 review C-4).
// Without this, the runtime guard in the action handler threw a plain
// Error that bubbled up as `server_error` (500) instead of
// `invalid_body` (400).
export const bulkActionSchema = z
  .object({
    action: z.enum(['change_plan', 'archive']),
    member_ids: z
      .array(z.string().uuid())
      .min(1, 'At least one member_id is required')
      .max(BULK_CAP, `Cannot exceed ${BULK_CAP} members per batch`),
    params: z
      .object({
        new_plan_id: z.string().uuid().optional(),
        new_plan_year: z.number().int().min(2020).max(2100).optional(),
        override_reason_code: z.string().nullable().optional(),
        override_reason_note: z.string().max(500).nullable().optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.action === 'change_plan') {
      if (!data.params?.new_plan_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'new_plan_id'],
          message: 'change_plan requires params.new_plan_id',
        });
      }
      if (!data.params?.new_plan_year) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['params', 'new_plan_year'],
          message: 'change_plan requires params.new_plan_year',
        });
      }
    }
    // Staff-review SW-2: duplicate member_ids cause audit bloat (same change
    // logged twice) and subtle all-or-nothing oddities (e.g. archive fails
    // on 2nd iter because 1st iter already moved state to 'archived').
    // Reject duplicates early at the validation layer.
    const unique = new Set(data.member_ids);
    if (unique.size !== data.member_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['member_ids'],
        message: 'member_ids must be unique',
      });
    }
  });

export type BulkActionInput = z.infer<typeof bulkActionSchema>;

// --- Errors ------------------------------------------------------------------

export type BulkActionError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'bulk_cap_exceeded'; count: number }
  | { type: 'not_found'; memberId: string }
  | { type: 'plan_not_found'; planId: string }
  | { type: 'state_error'; memberId: string; code: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------
//
// RateLimitPort removed per round-2 review C-1. Rate limiting is a
// transport-layer concern and lives in the route handler only.

export type BulkActionDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
  plans: PlanLookupPort;
};

export type BulkActionMeta = {
  actorUserId: string;
  requestId: string;
};

export type BulkActionOutput = {
  updatedCount: number;
  auditEventCount: number;
};

// --- Implementation ----------------------------------------------------------

export async function bulkAction(
  input: unknown,
  meta: BulkActionMeta,
  deps: BulkActionDeps,
): Promise<Result<BulkActionOutput, BulkActionError>> {
  // 1. Validate input shape
  const parsed = bulkActionSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  // 2. Server-side cap enforcement (defense-in-depth — zod already caps)
  if (data.member_ids.length > BULK_CAP) {
    return err({ type: 'bulk_cap_exceeded', count: data.member_ids.length });
  }

  // 3. For change_plan: validate plan tenant ownership BEFORE opening
  //    the transaction (round-2 review I-5 — cross-tenant probe defence).
  if (data.action === 'change_plan' && data.params?.new_plan_id && data.params.new_plan_year) {
    const planResult = await deps.plans.getPlan(
      deps.tenant,
      asPlanId(data.params.new_plan_id),
      data.params.new_plan_year,
    );
    if (!planResult.ok) {
      return err({ type: 'plan_not_found', planId: data.params.new_plan_id });
    }
  }

  // 4. Execute all-or-nothing transaction
  const now = deps.clock.now();
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      let updatedCount = 0;
      let auditEventCount = 0;

      const memberIds = data.member_ids.map(asMemberId);

      // Staff-review SB-1 + SW-1: single batched SELECT with row locks
      // instead of N serial findById calls (which previously opened their
      // own transactions, causing TOCTOU lost-update + audit-diff lies).
      // `findManyByIdsInTx` uses `WHERE member_id = ANY($1) FOR UPDATE` —
      // all rows locked in one round-trip; locks released on COMMIT / ROLLBACK.
      const lookupResult = await deps.memberRepo.findManyByIdsInTx(
        tx,
        memberIds,
      );
      if (!lookupResult.ok) {
        logger.error(
          { err: lookupResult.error, requestId: meta.requestId },
          'bulk-action: findManyByIdsInTx unexpected error',
        );
        // Round-6 S-1: preserve error code so catch block can distinguish
        // repo.unexpected from other lookup failures without parsing logs.
        throw new Error(`lookup_failed:${lookupResult.error.code}`);
      }
      const membersMap = lookupResult.value;

      // Verify every requested id was returned (throw on first miss, same
      // behavior as the old serial loop — round-2 review I-11).
      for (const id of memberIds) {
        if (!membersMap.has(id)) {
          throw new BulkNotFoundError(id);
        }
      }

      for (const memberId of memberIds) {
        const current = membersMap.get(memberId)!;

        // Apply action
        switch (data.action) {
          case 'archive': {
            const archiveResult = archive(current, now);
            if (!archiveResult.ok) {
              throw new BulkStateError(memberId, archiveResult.error.code);
            }
            const updated = archiveResult.value;
            // Round-2 review C-2: use updateStatusInTx(tx, ...) so the
            // DB write joins the ambient transaction with the audit row.
            const persistResult = await deps.memberRepo.updateStatusInTx(
              tx,
              memberId,
              updated,
            );
            if (!persistResult.ok) {
              throw new Error(`persist:${persistResult.error.code}`);
            }

            const auditResult = await deps.audit.recordInTx(
              tx,
              deps.tenant,
              {
                type: 'member_archived',
                actorUserId: meta.actorUserId,
                requestId: meta.requestId,
                summary: `bulk archive member ${memberId}`,
                payload: {
                  member_id: memberId,
                  action: 'archive',
                  bulk_request_id: meta.requestId,
                },
              },
            );
            if (!auditResult.ok) throw new Error('audit_failed');
            updatedCount++;
            auditEventCount++;
            break;
          }

          case 'change_plan': {
            // Zod superRefine has already enforced that both fields are
            // present for change_plan — but narrow TS here explicitly.
            if (!data.params?.new_plan_id || !data.params?.new_plan_year) {
              // Unreachable in practice — guarded by zod. Defensive only.
              throw new Error('change_plan requires new_plan_id and new_plan_year');
            }
            // Staff-review SW-5: archived members MUST NOT be re-planned
            // in bulk — consistent with inline-edit's state_error on
            // archived members + domain `archive()`'s re-archive guard.
            if (current.status === 'archived') {
              throw new BulkStateError(
                memberId,
                'state.cannot_change_plan_archived',
              );
            }
            const newPlanId = asPlanId(data.params.new_plan_id);
            const patch = {
              planId: newPlanId,
              planYear: data.params.new_plan_year,
            };
            const persistResult = await deps.memberRepo.updateFieldsInTx(
              tx,
              memberId,
              patch,
            );
            if (!persistResult.ok) {
              throw new Error(`persist:${persistResult.error.code}`);
            }

            const auditResult = await deps.audit.recordInTx(
              tx,
              deps.tenant,
              {
                type: 'member_plan_changed',
                actorUserId: meta.actorUserId,
                requestId: meta.requestId,
                summary: `bulk change plan for member ${memberId}`,
                payload: {
                  member_id: memberId,
                  old_plan_id: current.planId,
                  new_plan_id: newPlanId,
                  new_plan_year: data.params.new_plan_year,
                  action: 'change_plan',
                  bulk_request_id: meta.requestId,
                },
              },
            );
            if (!auditResult.ok) throw new Error('audit_failed');
            updatedCount++;
            auditEventCount++;
            break;
          }

        }
      }

      return { updatedCount, auditEventCount };
    });

    return ok(result);
  } catch (e) {
    if (e instanceof BulkNotFoundError) {
      // Round-2 review I-11: single memberId, not an array — the
      // throw-on-first-miss pattern only reports one ID.
      return err({ type: 'not_found', memberId: e.memberId });
    }
    if (e instanceof BulkStateError) {
      return err({ type: 'state_error', memberId: e.memberId, code: e.stateCode });
    }
    // M2: log the rich cause server-side BEFORE sanitizing the wire response.
    // The route only sees the sanitized message, so without this an FK
    // violation / `audit_failed` / deadlock during the all-or-nothing tx
    // would collapse to "bulk operation failed" with zero forensic trace.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        requestId: meta.requestId,
        action: data.action,
      },
      'bulk-action: transaction rolled back',
    );
    // Round-2 review S-2: sanitize internal detail — don't leak
    // `persist:fk_violation_plan_id` etc. to callers.
    return err({
      type: 'server_error',
      message: 'bulk operation failed',
    });
  }
}

// --- Internal error classes --------------------------------------------------

class BulkNotFoundError extends Error {
  constructor(public readonly memberId: string) {
    super(`Member not found: ${memberId}`);
  }
}

class BulkStateError extends Error {
  constructor(
    public readonly memberId: string,
    public readonly stateCode: string,
  ) {
    super(`State error on member ${memberId}: ${stateCode}`);
  }
}
