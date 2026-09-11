/**
 * F114 — `acknowledgeChangeRequest` (US3; FR-010 "the submitting person
 * dismisses the shown decision"; contracts/portal-change-requests-api.md
 * § acknowledge).
 *
 * Stamps `outcome_acknowledged_at` on the caller's OWN decided request.
 * Another user's request answers `not_found` (never a 403 — no existence
 * leak across contacts, FR-029); a pending / withdrawn request answers
 * `not_decided`. Idempotent: the repo keeps the first stamp. No audit event
 * — a UI preference, not a data change. Read FOR UPDATE + stamp in one
 * `runInTenant`; refusals are throws so nothing is written.
 */
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ChangeRequest, ChangeRequestId } from '../../../domain/change-request/change-request';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { RepoError } from '../../ports/member-repo';
import { UseCaseAbort } from '../../tx-abort';

export type AcknowledgeChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'findByIdInTx' | 'acknowledgeInTx'>;
  readonly clock: ClockPort;
};

export type AcknowledgeChangeRequestInput = {
  readonly changeRequestId: ChangeRequestId;
  readonly actorUserId: UserId;
};

export type AcknowledgeChangeRequestError =
  | { readonly type: 'not_found' }
  | { readonly type: 'not_decided' }
  | { readonly type: 'server_error'; readonly message: string };

class Refusal extends UseCaseAbort<AcknowledgeChangeRequestError> {}

export async function acknowledgeChangeRequest(
  deps: AcknowledgeChangeRequestDeps,
  input: AcknowledgeChangeRequestInput,
): Promise<Result<{ readonly request: ChangeRequest }, AcknowledgeChangeRequestError>> {
  const now = deps.clock.now();
  try {
    const request = await runInTenant(deps.tenant, async (tx): Promise<ChangeRequest> => {
      const found = await deps.changeRequestRepo.findByIdInTx(tx, input.changeRequestId);
      if (!found.ok) {
        if (found.error.code === 'repo.not_found') throw new Refusal({ type: 'not_found' });
        throw new UseCaseAbort<RepoError>(found.error);
      }
      if (found.value.submittedByUserId !== input.actorUserId) throw new Refusal({ type: 'not_found' });
      if (found.value.state !== 'decided') throw new Refusal({ type: 'not_decided' });
      if (found.value.outcomeAcknowledgedAt !== null) return found.value;
      const stamped = await deps.changeRequestRepo.acknowledgeInTx(tx, found.value.id, now);
      if (!stamped.ok) throw new UseCaseAbort<RepoError>(stamped.error);
      return stamped.value;
    });
    return ok({ request });
  } catch (e) {
    if (e instanceof Refusal) return err(e.error);
    const code = e instanceof UseCaseAbort ? (e.error as RepoError).code : e instanceof Error ? e.name : String(e);
    logger.error(
      { tenantId: deps.tenant.slug, changeRequestId: input.changeRequestId, err: code },
      'change-request.acknowledge.failed',
    );
    return err({ type: 'server_error', message: `acknowledge: ${code}` });
  }
}
