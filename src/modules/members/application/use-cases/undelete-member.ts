/**
 * `undelete-member` use case (T139, US7 FR-005).
 *
 * Restores an archived member (status='archived' → 'active',
 * archived_at → NULL) provided it is still within the 90-day
 * undelete window. Emits a `member_undeleted` audit event.
 *
 * Does NOT re-activate linked user sessions — those were revoked on
 * archive (`user_sessions_revoked`) and the user must sign in again
 * via the standard F1 flow. This is intentional: when the archive
 * decision is reversed, the original session state is gone and the
 * user has to re-authenticate.
 *
 * R005 (staff-review-20260417-us7) — note on invitations: undelete
 * does NOT re-issue the invitations that archive soft-consumed. Those
 * tokens are dead forever (consumed_at stays set). If the admin wants
 * portal access restored for a previously-invited contact, they must
 * manually re-invite via "Invite to portal" on the member detail page
 * after undelete. This is a deliberate asymmetry: archive is a
 * one-way dead-drop on pending invites to block an exposed attack
 * surface; undelete restores only the member record, not the broader
 * invite lifecycle.
 *
 * Failure modes:
 *   - `not_found` — member missing / cross-tenant.
 *   - `state_error: undelete_only_from_archived` — not archived.
 *   - `state_error: undelete_window_expired` — > 90 days old.
 *   - `server_error` — anything else.
 */

import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { undelete, type Member, type MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';

export type UndeleteMemberError =
  | { type: 'not_found' }
  | { type: 'state_error'; code: string; daysSinceArchive?: number }
  | { type: 'server_error'; message: string };

export type UndeleteMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
};

export type UndeleteMemberMeta = {
  actorUserId: string;
  requestId: string;
};

class UndeleteNotFoundError extends Error {
  constructor() {
    super('not_found');
  }
}

class UndeleteStateError extends Error {
  constructor(
    public readonly stateCode: string,
    public readonly daysSinceArchive?: number,
  ) {
    super('state_error');
  }
}

export async function undeleteMember(
  memberId: MemberId,
  meta: UndeleteMemberMeta,
  deps: UndeleteMemberDeps,
): Promise<Result<Member, UndeleteMemberError>> {
  const now = deps.clock.now();

  try {
    const restored = await runInTenant(deps.tenant, async (tx) => {
      const current = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!current.ok) {
        if (current.error.code === 'repo.not_found')
          throw new UndeleteNotFoundError();
        throw new Error(`lookup_failed:${current.error.code}`);
      }

      const transitioned = undelete(current.value, now);
      if (!transitioned.ok) {
        const e = transitioned.error;
        if (e.code === 'state.undelete_window_expired') {
          throw new UndeleteStateError(e.code, e.daysSinceArchive);
        }
        throw new UndeleteStateError(e.code);
      }

      const persistResult = await deps.memberRepo.updateStatusInTx(
        tx,
        memberId,
        transitioned.value,
      );
      if (!persistResult.ok) {
        throw new Error(`persist_failed:${persistResult.error.code}`);
      }

      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_undeleted',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_undeleted ${memberId}`,
        payload: {
          member_id: memberId,
        },
      });
      if (!auditResult.ok) throw new Error('audit_failed');

      return persistResult.value;
    });

    return ok(restored);
  } catch (e) {
    if (e instanceof UndeleteNotFoundError) {
      return err({ type: 'not_found' });
    }
    if (e instanceof UndeleteStateError) {
      return err(
        e.daysSinceArchive !== undefined
          ? { type: 'state_error', code: e.stateCode, daysSinceArchive: e.daysSinceArchive }
          : { type: 'state_error', code: e.stateCode },
      );
    }
    logger.error(
      { err: e, memberId, requestId: meta.requestId },
      'undelete-member: unhandled',
    );
    return err({ type: 'server_error', message: 'undelete failed' });
  }
}
