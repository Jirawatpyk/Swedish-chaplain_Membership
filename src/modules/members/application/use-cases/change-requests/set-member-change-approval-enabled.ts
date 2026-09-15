/**
 * F114 — `setMemberChangeApprovalEnabled` (US6 AS4; FR-031; research R11;
 * contracts/admin-change-requests-api.md § settings).
 *
 * The per-tenant approval switch: one `runInTenant` → the upsert of
 * `tenant_member_settings.member_change_approval_enabled` (the port returns
 * the PREVIOUS value) → ONE audit row `member_change_approval_setting_changed
 * { previous, next, actor_role }` when the value actually changed. An
 * unchanged value is a no-op answer (`changed: false`, no audit) — the
 * upsert of the same value is idempotent and the audit trail records
 * transitions, not clicks. No member key in the payload: a setting flip is
 * not member activity, so migration 0009's `last_activity_at` trigger has
 * nothing to fire on.
 *
 * `actor_role` is the SESSION role the route passes, `null` when it has
 * none — never a literal (`check:actor-role-truth`).
 *
 * Every fault after the first write is a `UseCaseAbort` — never `return
 * err()` inside the callback (a resolved refusal COMMITS under
 * `runInTenant`).
 */
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { AuditPort, ChangeRequestAuditPayload } from '../../ports/audit-port';
import type { ClockPort } from '../../ports/clock-port';
import { isRepoError, repoErrorCause, type RepoError } from '../../ports/member-repo';
import type { TenantMemberChangeSettingsPort } from '../../ports/tenant-member-change-settings-port';
import { UseCaseAbort } from '../../tx-abort';

export type SetMemberChangeApprovalEnabledDeps = {
  readonly tenant: TenantContext;
  readonly tenantMemberChangeSettings: Pick<TenantMemberChangeSettingsPort, 'setApprovalEnabledInTx'>;
  readonly audit: Pick<AuditPort, 'recordInTx'>;
  readonly clock: ClockPort;
};

export type SetMemberChangeApprovalEnabledInput = {
  readonly enabled: boolean;
  readonly actorUserId: UserId;
  /** The SESSION role — recorded in the audit payload as `actor_role` (`null` when absent). */
  readonly actorRole?: string | null;
  readonly requestId: string;
};

export type SetMemberChangeApprovalEnabledOutcome = {
  readonly approvalEnabled: boolean;
  readonly previous: boolean;
  /** `false` when the stored value already matched — no audit row was written. */
  readonly changed: boolean;
  /** The clock instant of the change; `null` on a no-op. */
  readonly changedAt: Date | null;
};

export type SetMemberChangeApprovalEnabledError = { readonly type: 'server_error'; readonly message: string };

export async function setMemberChangeApprovalEnabled(
  deps: SetMemberChangeApprovalEnabledDeps,
  input: SetMemberChangeApprovalEnabledInput,
): Promise<Result<SetMemberChangeApprovalEnabledOutcome, SetMemberChangeApprovalEnabledError>> {
  const now = deps.clock.now();
  try {
    const outcome = await runInTenant(deps.tenant, async (tx): Promise<SetMemberChangeApprovalEnabledOutcome> => {
      const written = await deps.tenantMemberChangeSettings.setApprovalEnabledInTx(tx, deps.tenant.slug, input.enabled);
      if (!written.ok) throw new UseCaseAbort<RepoError>(written.error);

      const previous = written.value.previous;
      if (previous === input.enabled) {
        return { approvalEnabled: input.enabled, previous, changed: false, changedAt: null };
      }

      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_change_approval_setting_changed',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `member change approval ${previous ? 'on' : 'off'} → ${input.enabled ? 'on' : 'off'}`,
        payload: ({
          previous,
          next: input.enabled,
          actor_role: input.actorRole ?? null,
        } satisfies ChangeRequestAuditPayload['member_change_approval_setting_changed']),
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);

      return { approvalEnabled: input.enabled, previous, changed: true, changedAt: now };
    });
    return ok(outcome);
  } catch (e) {
    // an aborted tx carries the repo's own code + cause; anything else is a throw
    const repoError = e instanceof UseCaseAbort && isRepoError(e.error) ? e.error : null;
    const code = repoError?.code ?? (e instanceof Error ? e.name : String(e));
    logger.error(
      {
        tenantId: deps.tenant.slug,
        requestId: input.requestId,
        err: code,
        cause: repoError === null ? undefined : errKind(repoErrorCause(repoError)),
      },
      'change-request.setting.failed',
    );
    return err({ type: 'server_error', message: `set-approval: ${code}` });
  }
}
