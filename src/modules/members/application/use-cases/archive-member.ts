/**
 * `archive-member` use case (T138, US7 FR-005).
 *
 * Archives a member (sets `status = 'archived'`, `archived_at = NOW()`)
 * and cascades session revocation on every linked user within the member.
 *
 * Cascade design (spec US7 AS4 + edge case "Contact tied to a pending F1
 * invitation"):
 *   - Inside the same tx, SELECT `contacts.linked_user_id` for every
 *     non-removed contact on the archived member. For each linked user,
 *     call `SessionRevocationPort.revokeAllForInTx` with reason
 *     `admin_force` so the user can no longer sign in as the member.
 *   - Pending/unredeemed F1 invitation revocation is a forward-looking
 *     item (F1 invitation tokens already refuse to bind if the member
 *     is archived — verified by the F1 invitation flow).
 *
 * Failure modes:
 *   - `not_found`  — member missing or cross-tenant (RLS hides it).
 *   - `state_error` — already archived.
 *   - `server_error` — anything unexpected; full tx rolled back.
 *
 * Audit: one `member_archived` event + one `user_sessions_revoked` per
 * linked user whose sessions were killed.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { archive, type Member, type MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsCascadePort } from '../ports/broadcasts-cascade-port';
import type { ClockPort } from '../ports/clock-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { InvitationCascadePort } from '../ports/invitation-cascade-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';

export const archiveMemberSchema = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .strict();

export type ArchiveMemberInput = z.infer<typeof archiveMemberSchema>;

export type ArchiveMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'not_found' }
  | { type: 'state_error'; code: string }
  | { type: 'server_error'; message: string };

export type ArchiveMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  invitations: InvitationCascadePort;
  sessions: SessionRevocationPort;
  /**
   * F7 in-flight broadcasts cascade (T178a / T199 H-1).
   * REQUIRED in production. Tests must inject a no-op stub via
   * `noopBroadcastsCascadeAdapter` exported from
   * `@/modules/members/infrastructure/adapters/broadcasts-cascade-adapter`.
   * Earlier `?` typing was a PDPA/GDPR compliance gap — a forgotten
   * adapter injection silently broke the Art. 17 / PDPA §33 cascade
   * invariant; making the dep required surfaces that bug at typecheck.
   */
  broadcastsCascade: BroadcastsCascadePort;
  audit: AuditPort;
  clock: ClockPort;
};

export type ArchiveMemberMeta = {
  actorUserId: string;
  requestId: string;
};

class ArchiveNotFoundError extends Error {
  constructor() {
    super('not_found');
  }
}

class ArchiveStateError extends Error {
  constructor(public readonly stateCode: string) {
    super('state_error');
  }
}

export async function archiveMember(
  memberId: MemberId,
  input: unknown,
  meta: ArchiveMemberMeta,
  deps: ArchiveMemberDeps,
): Promise<Result<Member, ArchiveMemberError>> {
  const parsed = archiveMemberSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const reason = parsed.data.reason ?? null;
  const now = deps.clock.now();

  try {
    const archived = await runInTenant(deps.tenant, async (tx) => {
      // Lock the row (SELECT ... FOR UPDATE) — prevents a concurrent
      // plan change / inline-edit from clobbering status after we read.
      const current = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!current.ok) {
        if (current.error.code === 'repo.not_found')
          throw new ArchiveNotFoundError();
        throw new Error(`lookup_failed:${current.error.code}`);
      }

      const transitioned = archive(current.value, now);
      if (!transitioned.ok) {
        throw new ArchiveStateError(transitioned.error.code);
      }

      const persistResult = await deps.memberRepo.updateStatusInTx(
        tx,
        memberId,
        transitioned.value,
      );
      if (!persistResult.ok) {
        throw new Error(`persist_failed:${persistResult.error.code}`);
      }

      // Cascade — read linked users inside the same tx snapshot so we
      // revoke exactly the sessions of the users linked at archive time.
      // Principle III: via ContactRepo port, not a raw schema select.
      const linkedUserIds = await deps.contactRepo.listLinkedUserIdsForMemberInTx(
        tx,
        memberId,
      );

      // R002 (staff-review-20260417-us7) — dedupe linkedUserIds before
      // revocation: if the same F1 user is linked to multiple contacts
      // on this member (rare — one person holding two role titles),
      // iterating the raw list would emit duplicate `user_sessions_revoked`
      // audits (first call revokes N, subsequent calls revoke 0 but still
      // emit). Set-dedupe keeps exactly one audit per user.
      const uniqueLinkedUserIds = Array.from(new Set(linkedUserIds));

      let sessionsRevokedTotal = 0;
      for (const userId of uniqueLinkedUserIds) {
        const revoked = await deps.sessions.revokeAllForInTx(
          tx,
          userId,
          'admin_force',
        );
        if (!revoked.ok) {
          throw new Error(`session_revoke_failed:${revoked.error.code}`);
        }
        sessionsRevokedTotal += revoked.value.revokedCount;

        const sessionAudit = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'user_sessions_revoked',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `sessions revoked for user ${userId} — member archived`,
          payload: {
            user_id: userId,
            member_id: memberId,
            revoked_count: revoked.value.revokedCount,
            reason: 'admin_force_archive',
          },
        });
        if (!sessionAudit.ok) throw new Error('audit_failed');
      }

      // Soft-consume any pending/unredeemed invitations for the linked
      // users so the invite links become dead — defense-in-depth per
      // spec Edge Cases. Cross-module boundary handled via
      // InvitationCascadePort (Principle III). R001 column-grant
      // semantics preserved inside the adapter (`returning({ userId })`
      // only — never exposes `invitations.id`).
      const { revokedCount: invitationsRevokedCount } =
        await deps.invitations.softConsumePendingForUsersInTx(
          tx,
          uniqueLinkedUserIds,
          now,
        );

      // R004 (staff-review-20260417-us7) — `reason` is admin free-text
      // (up to 500 chars) and lands verbatim in this audit payload.
      // Same PDPA/GDPR risk posture as the `notes` field (spec § Security
      // considerations). Flagged for F9 GDPR self-service export carve-out
      // alongside `notes` and `override_reason_note`.
      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_archived',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_archived ${memberId}`,
        payload: {
          member_id: memberId,
          reason,
          cascaded_user_ids: uniqueLinkedUserIds,
          sessions_revoked_total: sessionsRevokedTotal,
          invitations_revoked_count: invitationsRevokedCount,
        },
      });
      if (!auditResult.ok) throw new Error('audit_failed');

      return persistResult.value;
    });

    // F7 in-flight broadcasts cascade (T178a / Coverage Gap C2 / T199 H-1).
    // Runs AFTER the F3 archival tx commits — the cascade opens its own
    // short tx per broadcast (independent row-locks; concurrent races
    // on individual broadcasts do not roll back the whole F3 archive).
    // Failure here is non-fatal: the adapter logs + returns zero so the
    // member archive remains successful even if a transient F7 issue
    // leaves a broadcast in-flight. Ops can re-run cleanup manually.
    {
      try {
        await deps.broadcastsCascade.cancelInFlightForMember(
          deps.tenant,
          memberId,
          {
            cancellationReason: 'originator_member_deleted',
            initiatedByUserId: meta.actorUserId,
            requestId: meta.requestId,
          },
        );
      } catch (cascadeErr) {
        logger.error(
          {
            err:
              cascadeErr instanceof Error
                ? cascadeErr.message
                : String(cascadeErr),
            memberId,
            requestId: meta.requestId,
            cascade: 'f7_in_flight_broadcast_cancel',
          },
          'archive-member: broadcasts cascade threw — member archive succeeded',
        );
      }
    }

    return ok(archived);
  } catch (e) {
    if (e instanceof ArchiveNotFoundError) {
      return err({ type: 'not_found' });
    }
    if (e instanceof ArchiveStateError) {
      return err({ type: 'state_error', code: e.stateCode });
    }
    logger.error(
      { err: e, memberId, requestId: meta.requestId },
      'archive-member: unhandled',
    );
    return err({ type: 'server_error', message: 'archive failed' });
  }
}
