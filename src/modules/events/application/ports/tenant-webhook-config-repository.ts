/**
 * T031c — `TenantWebhookConfigRepository` Application port (F6).
 *
 * CRUD access to the `tenant_webhook_configs` table from Application
 * use-cases. The Infrastructure adapter
 * (`drizzle-tenant-webhook-config-repository.ts`, Phase 5 T073)
 * implements via Drizzle.
 *
 * Used by:
 *   - Webhook receiver (Phase 3 T052): `findByTenantSource` to fetch the
 *     active + grace secrets for verification.
 *   - Admin wizard (Phase 5 T070–T072): `insert`, `rotateSecret`,
 *     `setEnabled`.
 *   - Grace-window cleanup cron (Phase 10): `clearExpiredGrace` for
 *     rows where grace_rotated_at < now - 24h. Caller iterates
 *     tenants and runs the function inside `runInTenant(ctx, fn)`;
 *     the predicate is pinned to `source='eventcreate'` at the
 *     adapter for the current F6 surface (extend to a closed
 *     `source` enum loop if a future source — e.g. CSV/EventCreate-
 *     V2 — gains its own grace columns).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { WebhookSecret } from '../../domain/branded-types';
import type { TenantWebhookConfigAggregate } from '../../domain/tenant-webhook-config';
import type { Source } from '../../domain/value-objects/source';

export type TenantWebhookConfigRepositoryError =
  | { readonly kind: 'db_error'; readonly message: string }
  | {
      readonly kind: 'already_exists';
      readonly tenantId: TenantId;
      readonly source: Source;
    }
  | {
      readonly kind: 'not_found';
      readonly tenantId: TenantId;
      readonly source: Source;
    };

export interface InsertConfigInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  readonly activeSecret: WebhookSecret;
}

export interface RotateSecretInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  readonly newActiveSecret: WebhookSecret;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

export interface TenantWebhookConfigRepository {
  /**
   * Creates a new row. Returns `already_exists` error if a row already
   * exists for `(tenantId, source)` — the use-case converts this to
   * HTTP 409 per contracts/admin-integration-eventcreate-api.md.
   */
  insert(
    input: InsertConfigInput,
  ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>>;

  findByTenantSource(
    tenantId: TenantId,
    source: Source,
  ): Promise<Result<TenantWebhookConfigAggregate | null, TenantWebhookConfigRepositoryError>>;

  /**
   * Atomically: moves active → grace + sets grace_rotated_at = now +
   * writes new active + updates last_rotated_at. Single-statement
   * UPDATE so the rotation is observable atomically by concurrent
   * webhook deliveries (no half-state where active and grace are both
   * the old secret).
   */
  rotateSecret(
    input: RotateSecretInput,
  ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>>;

  setEnabled(
    tenantId: TenantId,
    source: Source,
    enabled: boolean,
  ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>>;

  /**
   * Updates `last_received_at = now` atomically with the webhook
   * delivery tx (FR-037 strict-transactional). Returns void on
   * success — the use-case does not need the updated aggregate back.
   */
  touchLastReceivedAt(
    tenantId: TenantId,
    source: Source,
    receivedAt: Date,
  ): Promise<Result<void, TenantWebhookConfigRepositoryError>>;

  /**
   * Grace-window cleanup per R7. Clears `webhook_secret_grace` +
   * `grace_rotated_at` on all rows where grace_rotated_at <
   * (now - 24h). Returns the count of cleaned rows for the daily
   * cron's audit payload. Multi-tenant safe — caller runs this
   * inside `runInTenant(ctx, fn)` per super-admin enumeration loop.
   */
  clearExpiredGrace(
    tenantId: TenantId,
    olderThan: Date,
  ): Promise<Result<number, TenantWebhookConfigRepositoryError>>;
}
