/**
 * F114 — `withdrawChangeRequest` (US5 AS1; FR-009, FR-017, FR-025;
 * contracts/portal-change-requests-api.md § withdraw).
 *
 * Withdraws the caller's OWN pending request — found by the submitter's user
 * id (FOR UPDATE), never by an id from the body, so another contact's request
 * can never be the one closed (FR-009: only the submitting person, never a
 * colleague, never staff — they reject). One `runInTenant`: the pending read
 * → `withdrawInTx(id, 'member')` → ONE audit row
 * `member_change_request_withdrawn` keyed `member_id` (snake_case: a
 * withdrawal IS member activity, so migration 0009's `last_activity_at`
 * trigger fires — unlike `replaced` / `erasure`, which carry
 * `related_member_id`). A refusal is a throw inside the tx (nothing written);
 * every fault after the first write is a `UseCaseAbort` — never `return
 * err()` inside the callback.
 *
 * Races (FR-017 "first committed transition wins"): the FOR UPDATE read
 * serialises against a concurrent decide; if a decision committed first the
 * read finds no pending row → `no_pending_request`. The repo's
 * `WHERE state = 'pending'` UPDATE matching nothing is the same answer.
 */
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ChangeRequest } from '../../../domain/change-request/change-request';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { AuditPort, ChangeRequestAuditPayload } from '../../ports/audit-port';
import type { ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import { isRepoError, type RepoError } from '../../ports/member-repo';
import { UseCaseAbort } from '../../tx-abort';

export type WithdrawChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'findPendingBySubmitterInTx' | 'withdrawInTx'>;
  readonly audit: Pick<AuditPort, 'recordInTx'>;
  readonly clock: ClockPort;
};

export type WithdrawChangeRequestInput = {
  readonly actorUserId: UserId;
  /** The SESSION role — recorded in the audit payload as `actor_role`. */
  readonly actorRole: string;
  readonly requestId: string;
};

export type WithdrawChangeRequestError =
  | { readonly type: 'no_pending_request' }
  | { readonly type: 'server_error'; readonly message: string };

class Refusal extends UseCaseAbort<WithdrawChangeRequestError> {}

export async function withdrawChangeRequest(
  deps: WithdrawChangeRequestDeps,
  input: WithdrawChangeRequestInput,
): Promise<Result<{ readonly request: ChangeRequest }, WithdrawChangeRequestError>> {
  const now = deps.clock.now();
  try {
    const request = await runInTenant(deps.tenant, async (tx): Promise<ChangeRequest> => {
      const pending = await deps.changeRequestRepo.findPendingBySubmitterInTx(tx, input.actorUserId);
      if (!pending.ok) throw new UseCaseAbort<RepoError>(pending.error);
      if (pending.value === null) throw new Refusal({ type: 'no_pending_request' });

      const withdrawn = await deps.changeRequestRepo.withdrawInTx(tx, pending.value.id, { reason: 'member', withdrawnAt: now });
      if (!withdrawn.ok) {
        // the UPDATE matched no pending row: a transition committed between
        // the read and the write (FR-017) — the honest answer is "nothing to withdraw"
        if (withdrawn.error.code === 'repo.not_found') throw new Refusal({ type: 'no_pending_request' });
        throw new UseCaseAbort<RepoError>(withdrawn.error);
      }

      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_change_request_withdrawn',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `change request ${pending.value.id} withdrawn by the submitter`,
        payload: ({
          member_id: pending.value.memberId,
          request_id: pending.value.id,
          contact_id: pending.value.submittedByContactId,
          scope: pending.value.scope,
          withdrawn_reason: 'member',
          actor_role: input.actorRole,
        } satisfies ChangeRequestAuditPayload['member_change_request_withdrawn']),
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);

      return withdrawn.value;
    });
    return ok({ request });
  } catch (e) {
    if (e instanceof Refusal) return err(e.error);
    const code = e instanceof UseCaseAbort && isRepoError(e.error) ? e.error.code : e instanceof Error ? e.name : String(e);
    const cause = e instanceof UseCaseAbort && isRepoError(e.error) ? errKind('cause' in e.error ? e.error.cause : undefined) : undefined;
    logger.error(
      { tenantId: deps.tenant.slug, requestId: input.requestId, err: code, cause },
      'change-request.withdraw.failed',
    );
    return err({ type: 'server_error', message: `withdraw: ${code}` });
  }
}
