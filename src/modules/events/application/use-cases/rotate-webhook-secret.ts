/**
 * `rotateWebhookSecret` use-case (F6 Application, Phase 5 T071).
 *
 * Atomically rotates the tenant's active webhook secret per FR-008 +
 * research.md R7:
 *   1. Move current `webhook_secret_active` → `webhook_secret_grace`
 *   2. Set `grace_rotated_at = now` (24h grace window starts ticking)
 *   3. Write new active secret
 *   4. Update `last_rotated_at = now`
 *   5. Emit `webhook_secret_rotated` audit (5y retention)
 *
 * The repository's `rotateSecret` performs steps 1–4 in a single
 * UPDATE so concurrent webhook deliveries either see (old active +
 * null grace) or (new active + old grace) — never (old active + old
 * grace) which would be a transient half-state.
 *
 * **Rate-limit gate lives at route layer** — the contract requires
 * 3 rotations/hour per (tenant, actor) per FR-008. Putting the
 * rate-limit in the route handler keeps the use-case framework-free
 * (Principle III) and lets the gate fire BEFORE any DB hit.
 *
 * Audit payload carries `previousSecretLastFour` + `newSecretLastFour`
 * + `graceActiveUntil` — never the plaintext secrets. `pino.redact`
 * already covers `webhook_secret_active/grace`.
 *
 * `not_found` from the repository means the tenant tried to rotate
 * without first generating a secret — caller maps to HTTP 404 per
 * contract.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
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
import type { WebhookSecret } from '../../domain/branded-types';
import type { Source } from '../../domain/value-objects/source';
import { GRACE_WINDOW_MS } from '../../domain/tenant-webhook-config';
import { asSecretLastFour, type SecretLastFour } from '../../domain/secret-last-four';

export interface RotateWebhookSecretInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  readonly actorUserId: UserId;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

export interface RotateWebhookSecretOutput {
  /** Plaintext new active secret — caller MUST display once + never persist. */
  readonly secret: WebhookSecret;
  /** Last 4 chars for masked display + audit (branded — length=4 enforced). */
  readonly secretLastFour: SecretLastFour;
  /** ISO timestamp 24h after `now` when the grace secret is invalidated. */
  readonly graceActiveUntil: string;
}

export type RotateWebhookSecretError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'audit_emit_failed'; readonly inner: AuditEmitError };

export interface RotateWebhookSecretDeps {
  readonly repo: TenantWebhookConfigRepository;
  readonly audit: F6AuditPort;
  /**
   * Returns a freshly-generated 32-byte cryptographic random secret
   * encoded as base64url. Same factory contract as
   * `generateWebhookSecret` — composition layer wires once + reuses
   * across both use-cases.
   */
  readonly generateSecret: () => WebhookSecret;
}

export async function rotateWebhookSecret(
  input: RotateWebhookSecretInput,
  deps: RotateWebhookSecretDeps,
): Promise<Result<RotateWebhookSecretOutput, RotateWebhookSecretError>> {
  const newSecret = deps.generateSecret();
  // Round-6 verify-fix 2026-05-13 (code #5/#10 + type-design C8) —
  // shared `asSecretLastFour` from `domain/secret-last-four.ts`.
  const newSecretLastFour = asSecretLastFour(newSecret);

  const rotateResult = await deps.repo.rotateSecret({
    tenantId: input.tenantId,
    source: input.source,
    newActiveSecret: newSecret,
    now: input.now,
  });

  if (!rotateResult.ok) {
    return rotateResult;
  }

  // Previous active is now in the grace column (the repository's
  // atomic UPDATE shifted it across in step 1). Pull last4 from there
  // for the audit payload. After H3.1 the aggregate's `grace` field
  // is a GraceState union — on successful rotation it MUST be
  // `{ active: true }` (the DB CHECK + atomic UPDATE both enforce
  // that grace_secret + grace_rotated_at are set together).
  const previousSecretLastFour: SecretLastFour | 'none' = rotateResult.value
    .grace.active
    ? asSecretLastFour(rotateResult.value.grace.secret)
    : 'none';

  // 24h grace window per FR-008 + R7.
  const graceActiveUntilIso = new Date(
    input.now.getTime() + GRACE_WINDOW_MS,
  ).toISOString();

  const auditResult = await deps.audit.emit({
    eventType: 'webhook_secret_rotated',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.now,
    summary: `webhook secret rotated (prev_last4=${previousSecretLastFour} → new_last4=${newSecretLastFour}, grace_until=${graceActiveUntilIso})`,
    payload: {
      severity: 'warn',
      actorUserId: input.actorUserId,
      previousSecretLastFour,
      newSecretLastFour,
      graceActiveUntil: graceActiveUntilIso,
    },
  });

  if (!auditResult.ok) {
    // Side effect already happened (rotation committed) but audit is
    // lost — Principle I sub-clause 5 gap. logger.fatal preserves
    // forensic trail. Caller surfaces 500; admin retries (idempotent
    // shift: second rotate will produce yet another active, with the
    // first new-active becoming the second grace).
    logger.fatal(
      {
        event: 'f6_rotate_secret_audit_emit_failed',
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        previousSecretLastFour,
        newSecretLastFour,
        graceActiveUntil: graceActiveUntilIso,
        auditErrorKind: auditResult.error.kind,
      },
      '[F6] CRITICAL: webhook secret rotated but audit emit failed — forensic trail only in this log line',
    );
    return err({ kind: 'audit_emit_failed', inner: auditResult.error });
  }

  return ok({
    secret: newSecret,
    secretLastFour: newSecretLastFour,
    graceActiveUntil: graceActiveUntilIso,
  });
}
