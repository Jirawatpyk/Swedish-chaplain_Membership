/**
 * `forceExpireGraceSecret` use-case (F6 Application).
 *
 * Admin-triggered immediate invalidation of a tenant's webhook grace
 * secret. Normally the grace key auto-expires 24h after rotation per
 * FR-008 + research.md R7, but if the admin detects a compromise of
 * the OLD secret before the rotation window closes, they need a
 * mechanism to invalidate it instantly — waiting 24h leaves an
 * attacker window in which the old secret continues to verify.
 *
 * Mechanism: wraps `TenantWebhookConfigRepository.clearExpiredGrace`.
 * The port semantics are "clear all rows where `grace_rotated_at <
 * cutoff`". By passing `cutoff = input.now`, we clear every grace row
 * whose rotation timestamp is strictly before NOW — which is every
 * active grace key (rotations always happen in the past from the
 * caller's perspective).
 *
 * Audit: emits `webhook_secret_force_expired` via the injected audit
 * port (Principle I sub-clause 5 — every security-sensitive admin
 * action must leave a 5-year forensic trail). Phase 5 T071 wires the
 * admin UI to inject the human actor; ops scripts invoke with
 * `actorUserId: null` for runbook-driven incident response.
 *
 * Pure Application — no framework imports. Tenant context injection
 * via `runInTenant`-bound repo (Constitution Principle III).
 */
import { ok, err, type Result } from '@/lib/result';
import type {
  TenantWebhookConfigRepository,
  TenantWebhookConfigRepositoryError,
} from '../ports/tenant-webhook-config-repository';
import type {
  F6AuditPort,
  AuditEmitError,
} from '../ports/audit-port';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';

export interface ForceExpireGraceSecretInput {
  readonly tenantId: TenantId;
  /** Admin user that initiated the force-expire; `null` for ops scripts. */
  readonly actorUserId: UserId | null;
  /** Free-text reason (incident ticket #, runbook step, etc.). */
  readonly reason: string;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

/**
 * Discriminated outcome. `no_grace_active` means there was nothing to
 * clear (already expired by the 24h sweep, or never rotated).
 * `cleared` means the force-expire actually invalidated 1 row.
 *
 * F6 v1 has one source per tenant (`'eventcreate'`) so `rowsCleared`
 * is always 0 or 1.
 */
export type ForceExpireGraceSecretOutput =
  | { readonly kind: 'no_grace_active' }
  | { readonly kind: 'cleared'; readonly rowsCleared: 1 };

export type ForceExpireGraceSecretError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'audit_emit_failed'; readonly inner: AuditEmitError };

export interface ForceExpireGraceSecretDeps {
  readonly repo: TenantWebhookConfigRepository;
  readonly audit: F6AuditPort;
}

export async function forceExpireGraceSecret(
  input: ForceExpireGraceSecretInput,
  deps: ForceExpireGraceSecretDeps,
): Promise<Result<ForceExpireGraceSecretOutput, ForceExpireGraceSecretError>> {
  const clearResult = await deps.repo.clearExpiredGrace(input.tenantId, input.now);
  if (!clearResult.ok) {
    return clearResult;
  }

  const rowsCleared = clearResult.value;
  const auditResult = await deps.audit.emit({
    eventType: 'webhook_secret_force_expired',
    tenantId: input.tenantId,
    actorType: input.actorUserId ? 'admin' : 'system',
    actorUserId: input.actorUserId,
    occurredAt: input.now,
    summary: `webhook grace secret force-expired (${rowsCleared} row(s) cleared): ${input.reason}`,
    payload: {
      severity: 'warn',
      actorUserId: input.actorUserId,
      rowsCleared,
      reason: input.reason,
    },
  });
  if (!auditResult.ok) {
    return err({ kind: 'audit_emit_failed', inner: auditResult.error });
  }

  if (rowsCleared === 0) {
    return ok({ kind: 'no_grace_active' });
  }
  return ok({ kind: 'cleared', rowsCleared: 1 });
}
