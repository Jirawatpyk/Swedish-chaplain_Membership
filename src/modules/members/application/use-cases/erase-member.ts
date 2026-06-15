/**
 * `erase-member` use case (COMP-1 — GDPR Art. 17 / PDPA §33).
 *
 * Anonymises a member + its contacts IN PLACE (the FK web forbids hard-delete)
 * and re-drives the existing archive cascades with the erasure reason.
 *
 * Flow (design §6):
 *   1. emit `member_erasure_requested` durably (its own committed tx) — starts
 *      the Art. 12 one-month clock and survives a later scrub failure.
 *   2. ATOMIC tx (runInTenant): scrub members + contacts (+ erased_at) and
 *      (Task 5) revoke sessions / soft-consume invitations for linked users.
 *   3. (Task 6) POST-COMMIT best-effort: cancel in-flight F7 broadcasts + F8
 *      renewal cycles with the erasure reason.
 *   4. (Task 6) emit `member_erased` ONLY when every cascade reports complete.
 *
 * Idempotent: re-running re-drives incomplete cascades; member_erased is the
 * completion proof. Per-module scrub of F1/F6/F7-content/F8 + the reconciler
 * are US2; the 10y tax-redaction cron is US3.
 */
import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsCascadePort } from '../ports/broadcasts-cascade-port';
import type { RenewalsCascadePort } from '../ports/renewals-cascade-port';
import type { ClockPort } from '../ports/clock-port';
import type { InvitationCascadePort } from '../ports/invitation-cascade-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';

export const eraseMemberSchema = z
  .object({
    reason: z.enum(['gdpr_erasure_request', 'pdpa_deletion_request']),
  })
  .strict();

export type EraseMemberInput = z.infer<typeof eraseMemberSchema>;

export type EraseMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'not_found' }
  | { type: 'server_error'; message: string };

export type EraseMemberResult = {
  readonly memberId: MemberId;
  readonly erasedAt: Date;
  /** true when every cascade reported complete and member_erased was emitted. */
  readonly completed: boolean;
};

export type EraseMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  invitations: InvitationCascadePort;
  sessions: SessionRevocationPort;
  broadcastsCascade: BroadcastsCascadePort;
  renewalsCascade: RenewalsCascadePort;
  audit: AuditPort;
  clock: ClockPort;
};

export type EraseMemberMeta = { actorUserId: string; requestId: string };

class EraseNotFoundError extends Error {
  constructor() {
    super('not_found');
  }
}

export async function eraseMember(
  memberId: MemberId,
  input: unknown,
  meta: EraseMemberMeta,
  deps: EraseMemberDeps,
): Promise<Result<EraseMemberResult, EraseMemberError>> {
  const parsed = eraseMemberSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const reason = parsed.data.reason;
  const now = deps.clock.now();

  // 1. Durable request audit — its OWN committed tx so the DPO log records the
  //    request even if the scrub below fails (Art. 12 clock start).
  try {
    await runInTenant(deps.tenant, async (tx) => {
      const requested = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_erasure_requested',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_erasure_requested ${memberId}`,
        payload: { member_id: memberId, reason },
      });
      if (!requested.ok) throw new Error('audit_failed');
    });
  } catch (e) {
    logger.error(
      { err: e, memberId, requestId: meta.requestId },
      'erase-member: requested-audit failed',
    );
    return err({ type: 'server_error', message: 'erase request audit failed' });
  }

  // 2. ATOMIC scrub tx — members + contacts (+ Task 5 linked-user cascade).
  //    M1: cascade counts captured inside the tx, surfaced to outer scope for
  //    the post-commit `member_erased` payload (DPO-log observability).
  let sessionsRevokedTotal = 0;
  let invitationsRevokedCount = 0;
  try {
    await runInTenant(deps.tenant, async (tx) => {
      // findByIdInTx takes a SELECT … FOR UPDATE row lock (mirrors
      // archive-member.ts) — keep it so a concurrent plan-change /
      // inline-edit cannot clobber the row between this read and the scrub.
      const current = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!current.ok) {
        if (current.error.code === 'repo.not_found')
          throw new EraseNotFoundError();
        throw new Error(`lookup_failed:${current.error.code}`);
      }

      // Read linked users FIRST — the contacts scrub below sets removed_at on
      // every contact, and listLinkedUserIdsForMemberInTx filters
      // removed_at IS NULL, so reading after the scrub would yield an empty
      // list and silently skip the session/invitation revocation (the Art.17
      // cascade). Stays in the SAME atomic tx as the scrubs, so this is still
      // a consistent "linked at erasure time" snapshot. (Bug I-1, 2026-06-16.)
      // Dedupe so the same user linked to two contacts yields exactly one
      // user_sessions_revoked audit (mirrors archive-member.ts).
      const linkedUserIds = await deps.contactRepo.listLinkedUserIdsForMemberInTx(tx, memberId);
      const uniqueLinkedUserIds = Array.from(new Set(linkedUserIds));

      const scrubMember = await deps.memberRepo.scrubPiiInTx(tx, memberId, {
        erasedAt: now,
      });
      if (!scrubMember.ok) {
        if (scrubMember.error.code === 'repo.not_found')
          throw new EraseNotFoundError();
        throw new Error(`member_scrub_failed:${scrubMember.error.code}`);
      }

      const scrubContacts = await deps.contactRepo.scrubPiiForMemberInTx(
        tx,
        memberId,
        { erasedAt: now },
      );
      if (!scrubContacts.ok)
        throw new Error(`contact_scrub_failed:${scrubContacts.error.code}`);

      // Cascade — revoke the sessions of the users linked at erasure time
      // (snapshot read above, before the scrubs shadowed removed_at).
      for (const userId of uniqueLinkedUserIds) {
        const revoked = await deps.sessions.revokeAllForInTx(tx, userId, 'admin_force');
        if (!revoked.ok) throw new Error(`session_revoke_failed:${revoked.error.code}`);
        sessionsRevokedTotal += revoked.value.revokedCount;

        const sessionAudit = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'user_sessions_revoked',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `sessions revoked for user ${userId} — member erased`,
          payload: {
            user_id: userId,
            member_id: memberId,
            revoked_count: revoked.value.revokedCount,
            reason: 'admin_force_erase',
          },
        });
        if (!sessionAudit.ok) throw new Error('audit_failed');
      }

      // Soft-consume any pending/unredeemed invitations for the linked users so
      // the invite links become dead (defense-in-depth). Cross-module boundary
      // via InvitationCascadePort (Principle III).
      const inv = await deps.invitations.softConsumePendingForUsersInTx(
        tx,
        uniqueLinkedUserIds,
        now,
      );
      invitationsRevokedCount = inv.revokedCount;
    });
  } catch (e) {
    if (e instanceof EraseNotFoundError) return err({ type: 'not_found' });
    logger.error(
      { err: e, memberId, requestId: meta.requestId },
      'erase-member: scrub tx failed',
    );
    return err({ type: 'server_error', message: 'erase scrub failed' });
  }

  // 3. POST-COMMIT best-effort cascades. Each opens its own tx (in the adapter)
  //    and must NOT roll back the committed scrub. Track whether every cascade
  //    reported a clean outcome — only then is the erasure "complete".
  let allCascadesClean = true;

  try {
    const r = await deps.broadcastsCascade.cancelInFlightForMember(deps.tenant, memberId, {
      cancellationReason: reason,
      initiatedByUserId: meta.actorUserId,
      requestId: meta.requestId,
    });
    if (r.outcome !== 'ok') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          outcome: r.outcome,
          cascade: 'f7_in_flight_broadcast_cancel',
        },
        'erase-member: broadcasts cascade not clean',
      );
    }
  } catch (cascadeErr) {
    allCascadesClean = false;
    logger.error(
      {
        err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'f7_in_flight_broadcast_cancel',
      },
      'erase-member: broadcasts cascade threw',
    );
  }

  try {
    const r = await deps.renewalsCascade.cancelInFlightForMember(deps.tenant, memberId, {
      cancellationReason: reason,
      initiatedByUserId: meta.actorUserId,
      requestId: meta.requestId,
    });
    if (r.outcome !== 'ok') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          outcome: r.outcome,
          cascade: 'f8_in_flight_cycle_cancel',
        },
        'erase-member: renewals cascade not clean',
      );
    }
  } catch (cascadeErr) {
    allCascadesClean = false;
    logger.error(
      {
        err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'f8_in_flight_cycle_cancel',
      },
      'erase-member: renewals cascade threw',
    );
  }

  // 4. Completion proof — emit member_erased ONLY when every cascade is clean.
  //    A partial run leaves erased_at set with NO member_erased; the US2
  //    reconciliation sweep re-drives the remainder and emits it then.
  if (allCascadesClean) {
    try {
      await runInTenant(deps.tenant, async (tx) => {
        const done = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_erased',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `member_erased ${memberId}`,
          payload: {
            member_id: memberId,
            reason,
            sessions_revoked_total: sessionsRevokedTotal,
            invitations_revoked_count: invitationsRevokedCount,
          },
        });
        if (!done.ok) throw new Error('audit_failed');
      });
    } catch (e) {
      allCascadesClean = false;
      logger.error(
        { err: e, memberId, requestId: meta.requestId },
        'erase-member: member_erased audit failed',
      );
    }
  }

  return ok({ memberId, erasedAt: now, completed: allCascadesClean });
}
