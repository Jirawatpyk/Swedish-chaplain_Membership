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
import { renewalsMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { undelete, type Member, type MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { RenewalsCascadePort } from '../ports/renewals-cascade-port';

export type UndeleteMemberError =
  | { type: 'not_found' }
  | { type: 'state_error'; code: string; daysSinceArchive?: number }
  | { type: 'server_error'; message: string };

export type UndeleteMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
  /**
   * Cluster 4 (2026-07-12) — F8 renewal-cycle RESTORE cascade. The
   * symmetric counterpart of archive-member's `cancelInFlightForMember`.
   * Archive cancels the in-flight cycle; undelete must re-create one, or
   * the restored member silently drops out of the renewal pipeline.
   * REQUIRED in production; tests inject `noopRenewalsCascadeAdapter` from
   * `@/modules/members/infrastructure/adapters/renewals-cascade-adapter`.
   * Runs POST-COMMIT best-effort — a failure logs + emits a metric but
   * does NOT fail the undelete (mirrors archive-member's cascade contract).
   */
  renewalsCascade: RenewalsCascadePort;
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

    // Cluster 4 (2026-07-12) — F8 renewal-cycle RESTORE cascade. Runs AFTER
    // the F3 undelete tx commits (mirrors archive-member's cancel cascade):
    // opens its own tx to idempotently re-create ONE active cycle anchored to
    // the member's current membership period, so the restored member
    // re-appears in the renewal pipeline. Best-effort: a failure logs + emits
    // a metric but does NOT fail the undelete (the member row is already
    // restored durably; ops can re-attempt via admin "renew" if the cycle
    // restore failed — e.g. the member's plan is no longer offered).
    {
      try {
        const restore = await deps.renewalsCascade.restoreForMember(
          deps.tenant,
          memberId,
          {
            initiatedByUserId: meta.actorUserId,
            requestId: meta.requestId,
          },
        );
        renewalsMetrics.restoreOutcome(deps.tenant.slug, restore.outcome);
        if (restore.outcome === 'restore_failed') {
          // The member is restored but has NO active cycle — a "member
          // silently dropped from the renewal pipeline" state. Structured
          // log keyed by memberId so ops can grep + re-attempt (admin renew).
          logger.error(
            {
              tenantId: deps.tenant.slug,
              memberId,
              requestId: meta.requestId,
              cascade: 'f8_undelete_cycle_restore',
            },
            'undelete-member: renewals restore failed — member restored WITHOUT an active cycle (re-attempt via admin renew)',
          );
        } else if (restore.outcome === 'skipped_member_absent') {
          logger.warn(
            {
              tenantId: deps.tenant.slug,
              memberId,
              requestId: meta.requestId,
              cascade: 'f8_undelete_cycle_restore',
            },
            'undelete-member: renewals restore skipped — member unreadable post-commit',
          );
        }
      } catch (restoreErr) {
        // The adapter is supposed to translate failures into typed outcomes;
        // a throw here means the adapter itself blew up (composition-root
        // mis-wire). Emit the failed metric + structured log; the member
        // undelete still committed and remains successful.
        renewalsMetrics.restoreOutcome(deps.tenant.slug, 'restore_failed');
        logger.error(
          {
            err:
              restoreErr instanceof Error
                ? restoreErr.message
                : String(restoreErr),
            errName:
              restoreErr instanceof Error ? restoreErr.name : undefined,
            memberId,
            requestId: meta.requestId,
            cascade: 'f8_undelete_cycle_restore',
          },
          'undelete-member: renewals restore threw — member undelete succeeded',
        );
      }
    }

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
