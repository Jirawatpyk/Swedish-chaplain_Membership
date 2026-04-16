/**
 * `bulk-action` use case (T104, US4 FR-018/019/019a/019b).
 *
 * Applies a bulk action (change_plan, archive, send_portal_invite) to
 * ≤100 members in a single all-or-nothing transaction. Per-actor rate
 * limit of 10 ops / 10 min is enforced before the transaction opens.
 *
 * Each affected member produces one audit event; the entire batch
 * commits or rolls back atomically (FR-019 — no partial state).
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
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
import type { RateLimitPort } from '../ports/rate-limit-port';

// --- Constants ---------------------------------------------------------------

export const BULK_CAP = 100;
export const BULK_RATE_MAX = 10;
export const BULK_RATE_WINDOW_SECONDS = 600; // 10 minutes

// --- Input schema ------------------------------------------------------------

export const bulkActionSchema = z
  .object({
    action: z.enum(['change_plan', 'archive', 'send_portal_invite']),
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
  .strict();

export type BulkActionInput = z.infer<typeof bulkActionSchema>;

// --- Errors ------------------------------------------------------------------

export type BulkActionError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'bulk_cap_exceeded'; count: number }
  | { type: 'rate_limited' }
  | { type: 'not_found'; missingIds: string[] }
  | { type: 'state_error'; memberId: string; code: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type BulkActionDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
  rateLimit: RateLimitPort;
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

  // 3. Per-actor rate limit: 10 ops / 10 min per (tenant, actor)
  const rateLimitKey = `bulk:${deps.tenant.slug}:${meta.actorUserId}`;
  const rl = await deps.rateLimit.check(
    rateLimitKey,
    BULK_RATE_MAX,
    BULK_RATE_WINDOW_SECONDS,
  );
  if (!rl.success) {
    // Emit audit event for rate-limit breach
    await deps.audit.record(deps.tenant, {
      type: 'bulk_action_rate_limit_exceeded',
      actorUserId: meta.actorUserId,
      requestId: meta.requestId,
      summary: `bulk rate limit exceeded for actor ${meta.actorUserId}`,
      payload: {
        action: data.action,
        attempted_count: data.member_ids.length,
        remaining: rl.remaining,
        reset: rl.reset,
      },
    });
    return err({ type: 'rate_limited' });
  }

  // 4. Execute all-or-nothing transaction
  const now = deps.clock.now();
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      let updatedCount = 0;
      let auditEventCount = 0;

      for (const rawId of data.member_ids) {
        const memberId = asMemberId(rawId);

        // Fetch current member state
        const currentResult = await deps.memberRepo.findById(
          deps.tenant,
          memberId,
        );
        if (!currentResult.ok) {
          throw new BulkNotFoundError(rawId);
        }
        const current = currentResult.value;

        // Apply action
        switch (data.action) {
          case 'archive': {
            const archiveResult = archive(current, now);
            if (!archiveResult.ok) {
              throw new BulkStateError(rawId, archiveResult.error.code);
            }
            const updated = archiveResult.value;
            const persistResult = await deps.memberRepo.updateStatus(
              deps.tenant,
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
            if (!data.params?.new_plan_id || !data.params?.new_plan_year) {
              throw new Error('change_plan requires new_plan_id and new_plan_year');
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

          case 'send_portal_invite': {
            // Portal invite is a fire-and-forget outbox action per member.
            // The actual invite sending is delegated to the outbox dispatcher.
            // For now, we just record the audit event — the invite-portal
            // use case is invoked per-member after the batch commits.
            const auditResult = await deps.audit.recordInTx(
              tx,
              deps.tenant,
              {
                type: 'member_updated',
                actorUserId: meta.actorUserId,
                requestId: meta.requestId,
                summary: `bulk portal invite queued for member ${memberId}`,
                payload: {
                  member_id: memberId,
                  action: 'send_portal_invite',
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
      return err({ type: 'not_found', missingIds: [e.memberId] });
    }
    if (e instanceof BulkStateError) {
      return err({ type: 'state_error', memberId: e.memberId, code: e.stateCode });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return err({ type: 'server_error', message: msg });
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
