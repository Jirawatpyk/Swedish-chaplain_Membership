/**
 * `bulk-action` use case (T104, US4 FR-018/019/019a/019b).
 *
 * Applies a bulk action (archive, unarchive) to ≤100 members in a
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
 * 126 — there is no bulk `change_plan`. The former arm skipped every
 * `changePlan` rule (soft-deleted plan, advisory lock, policy gates, the
 * F8 audit + listeners) and was unreachable anyway (a UUID schema for slug
 * plan ids, no UI button). A bulk plan change must reuse `changePlan`.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { primaryContactTriggerViolation } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  archive,
  asMemberId,
  undelete,
  type MemberId,
} from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import {
  revokeMemberAccessInTx,
  runPostArchiveCascades,
  runRenewalsRestoreCascade,
  type MemberAccessCascadeDeps,
  type PostArchiveCascadeDeps,
} from './archive-cascade';

// --- Constants ---------------------------------------------------------------

export const BULK_CAP = 100;
export const BULK_RATE_MAX = 10;
export const BULK_RATE_WINDOW_SECONDS = 600; // 10 minutes

// --- Input schema ------------------------------------------------------------
export const bulkActionSchema = z
  .object({
    action: z.enum(['archive', 'unarchive']),
    member_ids: z
      .array(z.string().uuid())
      .min(1, 'At least one member_id is required')
      .max(BULK_CAP, `Cannot exceed ${BULK_CAP} members per batch`),
  })
  .strict()
  .superRefine((data, ctx) => {
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
  | { type: 'state_error'; memberId: string; code: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------
//
// RateLimitPort removed per round-2 review C-1. Rate limiting is a
// transport-layer concern and lives in the route handler only.

export type BulkActionDeps = MemberAccessCascadeDeps &
  PostArchiveCascadeDeps & {
    tenant: TenantContext;
    memberRepo: MemberRepo;
    audit: AuditPort;
    clock: ClockPort;
  };

export type BulkActionMeta = {
  actorUserId: string;
  requestId: string;
};

export type BulkActionOutput = {
  updatedCount: number;
  auditEventCount: number;
  /**
   * The member IDs actually transitioned by this batch. Powers a precise Undo
   * on the client (e.g. archive → "Undo" posts `unarchive` with exactly these
   * ids), so undo never touches members the batch skipped or a race changed.
   */
  updatedIds: string[];
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

  // 3. Execute all-or-nothing transaction
  const now = deps.clock.now();
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      let updatedCount = 0;
      let auditEventCount = 0;
      const updatedIds: string[] = [];

      const memberIds = data.member_ids.map(asMemberId);

      // Staff-review SB-1 + SW-1: single batched SELECT with row locks
      // instead of N serial findById calls (which previously opened their
      // own transactions, causing TOCTOU lost-update + audit-diff lies).
      // `findManyByIdsInTx` uses `WHERE member_id = ANY($1) FOR UPDATE` —
      // all rows locked in one round-trip; locks released on COMMIT / ROLLBACK.
      const lookupResult = await deps.memberRepo.findManyByIdsInTx(
        tx,
        deps.tenant.slug,
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

      // 108 PR-B (T041 reliability round 2, N2) — GDPR Art.17 / PDPA §33: an
      // erased member is never restored. The single undelete gates on this;
      // this Undo-of-archive arm had no gate, and migration 0293 exempts
      // erased members, so an erased+archived id would have come back active.
      if (data.action === 'unarchive') {
        const erased = await deps.memberRepo.findErasedIdsInTx(tx, deps.tenant.slug, memberIds);
        if (!erased.ok) throw new Error(`erased_lookup_failed:${erased.error.code}`);
        for (const id of memberIds) {
          if (erased.value.has(id)) throw new BulkStateError(id, 'undelete_erased');
        }
        // 108 PR-B (T041 round 4, F4-#5) — the same rule as the single
        // undelete: a member with no live primary (a contact-less member
        // included — 0293 exempts those) is not restored. Partitioned BEFORE
        // any write; the batch stays all-or-nothing and names the member.
        const noPrimary = await deps.memberRepo.findIdsWithoutLivePrimaryInTx(
          tx,
          deps.tenant.slug,
          memberIds,
        );
        if (!noPrimary.ok) throw new Error(`primary_lookup_failed:${noPrimary.error.code}`);
        for (const id of memberIds) {
          if (noPrimary.value.has(id)) throw new BulkStateError(id, 'no_primary_contact');
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

            // 126 #2 — the single-archive in-tx cascade: revoke every linked
            // portal user's sessions and soft-consume their invitations.
            const cascade = await revokeMemberAccessInTx(tx, memberId, now, meta, deps);

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
                  cascaded_user_ids: cascade.cascadedUserIds,
                  sessions_revoked_total: cascade.sessionsRevokedTotal,
                  invitations_revoked_count: cascade.invitationsRevokedCount,
                },
              },
            );
            if (!auditResult.ok) throw new Error('audit_failed');
            updatedCount++;
            // member_archived + one user_sessions_revoked per linked user.
            auditEventCount += 1 + cascade.cascadedUserIds.length;
            break;
          }

          case 'unarchive': {
            // Inverse of `archive` — restores archived → active within the
            // 90-day undelete window (domain `undelete`). 126 #2 — bulk archive
            // now cancels the renewal cycle, so this arm runs the single
            // undelete's renewals-RESTORE cascade after the commit (below).
            // It still skips the single undelete's primary-contact designate
            // flow: the gates above refuse a member with no live primary.
            const undeleteResult = undelete(current, now);
            if (!undeleteResult.ok) {
              throw new BulkStateError(memberId, undeleteResult.error.code);
            }
            const persistResult = await deps.memberRepo.updateStatusInTx(
              tx,
              memberId,
              undeleteResult.value,
            );
            if (!persistResult.ok) {
              throw new Error(`persist:${persistResult.error.code}`);
            }
            const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
              type: 'member_undeleted',
              actorUserId: meta.actorUserId,
              requestId: meta.requestId,
              summary: `bulk unarchive member ${memberId}`,
              payload: {
                member_id: memberId,
                action: 'unarchive',
                bulk_request_id: meta.requestId,
              },
            });
            if (!auditResult.ok) throw new Error('audit_failed');
            updatedCount++;
            auditEventCount++;
            break;
          }

          default: {
            // Exhaustiveness guard: a future action added to the zod enum
            // without a case here would otherwise fall through and be recorded
            // in `updatedIds` below as a phantom success (no write, no audit).
            const _never: never = data.action;
            throw new Error(`unhandled bulk action: ${String(_never)}`);
          }
        }

        // Every member that reaches here transitioned successfully (any
        // failure throws out of the loop). Record its id for a precise Undo.
        updatedIds.push(memberId);
      }

      return { updatedCount, auditEventCount, updatedIds };
    });

    // 126 #2 — the single paths' POST-COMMIT cascades, per member, in their
    // own txs. Best-effort: the helpers log + count a failure and never fail
    // the batch that already committed.
    for (const id of result.updatedIds) {
      const memberId = asMemberId(id);
      if (data.action === 'archive') {
        await runPostArchiveCascades(memberId, meta, deps);
      } else {
        await runRenewalsRestoreCascade(memberId, meta, deps);
      }
    }
    // 127 — one line per batch once every member's cascade has run. A function
    // timeout mid-loop shows up as a batch with no completion line.
    logger.info(
      {
        requestId: meta.requestId,
        action: data.action,
        cascadesCompleted: result.updatedIds.length,
      },
      'bulk-action: post-commit cascades done',
    );

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
    // 108 PR-B (T041 reliability review, M2): the bulk `unarchive` arm is the
    // Undo of a bulk archive and skips the single-member designate flow on
    // purpose, so migration 0293's deferred trigger is what refuses a member
    // that would come back with no live primary. Its raise arrives here at
    // COMMIT as a bare DB error; the message names the member, so the admin
    // gets the same per-member `state_error` the route already renders
    // instead of "bulk operation failed" for the whole batch.
    const violation = primaryContactTriggerViolation(e);
    if (violation !== null && violation.memberId !== null) {
      // Round 4 (F4-#7): the typed answer must leave a server-side trace —
      // this is the one bulk failure an operator most needs to correlate
      // with a member id. `warn`, not `error`: the invariant did its job.
      logger.warn(
        {
          requestId: meta.requestId,
          action: data.action,
          memberId: violation.memberId,
          livePrimaries: violation.livePrimaries,
        },
        'bulk-action: refused at COMMIT by the primary-contact invariant (0293)',
      );
      return err({
        type: 'state_error',
        memberId: violation.memberId as MemberId,
        code: 'no_primary_contact',
      });
    }
    // A raise without a member uuid in it (a future message change) falls
    // through to the sanitized server_error below — never a blank memberId
    // the route would render as "member  could not be restored".
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
