/**
 * `generateWebhookSecret` use-case (F6 Application, Phase 5 T070).
 *
 * One-time-reveal secret generation for fresh tenant onboarding per
 * FR-024 + research.md R7. Creates a 32-byte cryptographic random
 * base64url secret, inserts the `tenant_webhook_configs` row, and
 * emits `webhook_secret_generated` audit (5y retention).
 *
 * Returns `secret_already_exists` if the tenant has already configured
 * a secret — the route handler maps this to HTTP 409 per
 * contracts/admin-integration-eventcreate-api.md. Caller must use
 * `rotateWebhookSecret` (T071) to replace an existing secret.
 *
 * **Secret never leaves the use-case unaudited**: audit emission is
 * NON-NEGOTIABLE under Principle I sub-clause 5 (security-sensitive
 * admin actions leave a 5-year forensic trail). If audit emit fails
 * AFTER the row was inserted, this is a forensic-trail gap — the
 * use-case logs `pino.fatal(...)` and returns `audit_emit_failed`
 * so the caller can surface the failure (operator follow-up required).
 *
 * Audit payload carries `secretLastFour` only — never the full plaintext.
 * `webhook_secret_active` is in the pino redact list and never logged.
 *
 * Pure Application — no framework imports. The `generateSecret` factory
 * is injected so deterministic unit tests can fixture the bytes
 * (Constitution Principle II testability).
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

export interface GenerateWebhookSecretInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  /** Admin user that initiated the generate. Cannot be `null` — FR-035 admin-only surface. */
  readonly actorUserId: UserId;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

export interface GenerateWebhookSecretOutput {
  /** Plaintext secret — caller MUST display once + never persist. */
  readonly secret: WebhookSecret;
  /** Last 4 chars for masked display + audit payload. */
  readonly secretLastFour: string;
}

export type GenerateWebhookSecretError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'secret_already_exists' }
  | { readonly kind: 'audit_emit_failed'; readonly inner: AuditEmitError };

export interface GenerateWebhookSecretDeps {
  readonly repo: TenantWebhookConfigRepository;
  readonly audit: F6AuditPort;
  /**
   * Returns a freshly-generated 32-byte cryptographic random secret
   * encoded as base64url. The factory contract is "pure-function over
   * crypto.randomBytes(32)" — production wires
   * `crypto.randomBytes(32).toString('base64url')`; tests inject a
   * deterministic stub.
   */
  readonly generateSecret: () => WebhookSecret;
}

/**
 * Extract the last 4 characters of the secret for masked display +
 * audit. Defensive: short secrets (test fixtures) get padded with the
 * full value rather than throwing — operationally a 32-byte secret is
 * always ≥40 chars base64url so the slice is always 4 chars in
 * production.
 */
function lastFour(secret: string): string {
  return secret.slice(-4);
}

export async function generateWebhookSecret(
  input: GenerateWebhookSecretInput,
  deps: GenerateWebhookSecretDeps,
): Promise<Result<GenerateWebhookSecretOutput, GenerateWebhookSecretError>> {
  const secret = deps.generateSecret();
  const secretLastFour = lastFour(secret);

  const insertResult = await deps.repo.insert({
    tenantId: input.tenantId,
    source: input.source,
    activeSecret: secret,
  });

  if (!insertResult.ok) {
    if (insertResult.error.kind === 'already_exists') {
      // FR-024 + contracts/admin-integration-eventcreate-api.md § 409:
      // caller must rotate instead.
      return err({ kind: 'secret_already_exists' });
    }
    return insertResult;
  }

  const auditResult = await deps.audit.emit({
    eventType: 'webhook_secret_generated',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.now,
    summary: `webhook secret generated (last4=${secretLastFour})`,
    payload: {
      severity: 'info',
      actorUserId: input.actorUserId,
      secretLastFour,
    },
  });

  if (!auditResult.ok) {
    // Side-effect already happened (row inserted) but the audit is
    // lost — Principle I sub-clause 5 gap. logger.fatal preserves the
    // forensic trail in pino/stderr so operators can reconstruct
    // post-incident. The composition layer surfaces this as a 500 so
    // the admin retries (idempotent: 409 on retry confirms creation).
    logger.fatal(
      {
        event: 'f6_generate_secret_audit_emit_failed',
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        secretLastFour,
        auditErrorKind: auditResult.error.kind,
      },
      '[F6] CRITICAL: webhook secret generated but audit emit failed — forensic trail only in this log line',
    );
    return err({ kind: 'audit_emit_failed', inner: auditResult.error });
  }

  return ok({ secret, secretLastFour });
}
