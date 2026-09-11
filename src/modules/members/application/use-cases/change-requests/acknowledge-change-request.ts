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
import type { AuditPort } from '../../ports/audit-port';
import type { ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { RepoError } from '../../ports/member-repo';
import { UseCaseAbort } from '../../tx-abort';
import { auditChangeRequestProbe } from './decide-change-request';

export type AcknowledgeChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'findByIdInTx' | 'acknowledgeInTx'>;
  /** `record` only — the miss probe (Constitution I.3); a successful acknowledge writes NO audit row. */
  readonly audit: Pick<AuditPort, 'record'>;
  readonly clock: ClockPort;
};

export type AcknowledgeChangeRequestInput = {
  readonly changeRequestId: ChangeRequestId;
  readonly actorUserId: UserId;
  /** The SESSION role — recorded on the probe audit only. */
  readonly actorRole: string;
  readonly requestId: string;
};

export type AcknowledgeChangeRequestError =
  | { readonly type: 'not_found' }
  | { readonly type: 'not_decided' }
  | { readonly type: 'server_error'; readonly message: string };

class Refusal extends UseCaseAbort<AcknowledgeChangeRequestError> {
  constructor(
    error: AcknowledgeChangeRequestError,
    /** false = the row was FOUND in this tenant (another contact's request) — not a cross-tenant probe. */
    readonly probe = true,
  ) {
    super(error);
  }
}

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
      // Another contact of the SAME member: refuse as not_found (no
      // existence leak, FR-029) but do NOT audit it as a cross-tenant probe —
      // the row is visible in this tenant (review: reliability I-5 / security M-1).
      if (found.value.submittedByUserId !== input.actorUserId) throw new Refusal({ type: 'not_found' }, false);
      if (found.value.state !== 'decided') throw new Refusal({ type: 'not_decided' });
      if (found.value.outcomeAcknowledgedAt !== null) return found.value;
      const stamped = await deps.changeRequestRepo.acknowledgeInTx(tx, found.value.id, now);
      if (!stamped.ok) throw new UseCaseAbort<RepoError>(stamped.error);
      return stamped.value;
    });
    return ok({ request });
  } catch (e) {
    if (e instanceof Refusal) {
      if (e.error.type === 'not_found' && e.probe) {
        await auditChangeRequestProbe(deps.audit, deps.tenant, {
          changeRequestId: input.changeRequestId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          requestId: input.requestId,
          action: 'acknowledge',
        });
      }
      return err(e.error);
    }
    const code = e instanceof UseCaseAbort ? (e.error as RepoError).code : e instanceof Error ? e.name : String(e);
    logger.error(
      { tenantId: deps.tenant.slug, changeRequestId: input.changeRequestId, requestId: input.requestId, err: code },
      'change-request.acknowledge.failed',
    );
    return err({ type: 'server_error', message: `acknowledge: ${code}` });
  }
}
