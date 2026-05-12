/**
 * Issue I-FULL-3 (full-scope review 2026-05-12) —
 * `forceExpireGraceSecret` use-case (F6 Application).
 *
 * Admin-triggered immediate invalidation of a tenant's webhook grace
 * secret. Normally the grace key auto-expires 24h after rotation per
 * FR-008 + research.md R7, but if the admin detects a compromise of
 * the OLD secret before the rotation window closes, they need a
 * mechanism to invalidate it instantly — waiting 24h leaves an
 * attacker window in which the old secret continues to verify.
 *
 * Mechanism: the use-case wraps the existing
 * `TenantWebhookConfigRepository.clearExpiredGrace(tenantId, olderThan)`
 * method (port already shipped Phase 2 T031c). By passing `olderThan
 * = new Date()` (i.e., "any grace older than NOW") we clear ALL grace
 * keys for the tenant, regardless of `grace_rotated_at` timestamp.
 *
 * Audit: this use-case does NOT emit its own audit event because the
 * F6 audit taxonomy (35 events) does not have a dedicated
 * "grace_force_expired" type. Phase 5 T071 will introduce the admin
 * rotation UI that wraps this use-case with a `webhook_secret_rotated`
 * audit emission (since force-expire is functionally the completion
 * of an early rotation). Until Phase 5, callers (e.g., a manual ops
 * runbook) are responsible for their own audit trail.
 *
 * Pure Application — no framework imports. Tenant context injection
 * via `runInTenant`-bound repo (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type {
  TenantWebhookConfigRepository,
  TenantWebhookConfigRepositoryError,
} from '../ports/tenant-webhook-config-repository';
import type { TenantId } from '@/modules/members';
import type { Source } from '../../domain/value-objects/source';

export interface ForceExpireGraceSecretInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

export interface ForceExpireGraceSecretOutput {
  /**
   * Number of grace-key rows cleared. Should be 0 (no grace active)
   * or 1 (force-expire succeeded). Higher values indicate a multi-row
   * tenant (1 per source × tenant); F6 v1 only supports source
   * `'eventcreate'` so 0 or 1 is the only realistic range.
   */
  readonly rowsCleared: number;
}

export interface ForceExpireGraceSecretDeps {
  readonly repo: TenantWebhookConfigRepository;
}

export async function forceExpireGraceSecret(
  input: ForceExpireGraceSecretInput,
  deps: ForceExpireGraceSecretDeps,
): Promise<
  Result<ForceExpireGraceSecretOutput, TenantWebhookConfigRepositoryError>
> {
  // Pass `input.now` as the cutoff — `clearExpiredGrace` clears every
  // row with `grace_rotated_at < cutoff`. Using NOW means "all grace
  // keys regardless of age" since every active grace was rotated at
  // some time before NOW.
  const result = await deps.repo.clearExpiredGrace(input.tenantId, input.now);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: { rowsCleared: result.value } };
}
