/**
 * T073 — Drizzle `TenantWebhookConfigRepository` adapter (F6 Infrastructure).
 *
 * Implements the Application port for CRUD access to
 * `tenant_webhook_configs` (migration 0129). Operations:
 *
 *   - `insert`              — first-time secret generation (FR-024).
 *                             ON CONFLICT DO NOTHING → returns
 *                             `already_exists` for the use-case to map
 *                             to HTTP 409.
 *   - `findByTenantSource`  — webhook receiver + admin GET config view.
 *   - `rotateSecret`        — atomic active→grace + new active in one
 *                             UPDATE (FR-008 + research.md R7). No
 *                             half-state where concurrent deliveries
 *                             could see both as the old secret.
 *   - `setEnabled`          — admin kill-switch toggle (FR-033).
 *   - `touchLastReceivedAt` — webhook delivery success heartbeat.
 *   - `clearExpiredGrace`   — daily cron / admin force-expire (R7
 *                             24h grace window cleanup).
 *
 * RLS reality: every method runs against the caller-supplied
 * `TenantTx` executor (the F6 convention from `drizzle-events-
 * repository.ts`). Callers MUST wrap with `runInTenant(ctx, fn)` so the
 * `chamber_app` role + `app.current_tenant` GUC are set before the
 * SELECT/INSERT/UPDATE hits the `tenant_webhook_configs` policy.
 *
 * DB invariant: the schema's CHECK constraint enforces
 * `webhook_secret_grace IS NULL ⟺ grace_rotated_at IS NULL`. Each
 * mutation here either sets both columns or clears both — never one
 * without the other.
 *
 * Constitution Principle III: Infrastructure types (Drizzle inferred
 * rows) do not leak into Application — the `toAggregate` converter
 * boxes the row into the pure-TypeScript `TenantWebhookConfigAggregate`.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import {
  tenantWebhookConfigs,
  type TenantWebhookConfigRow,
} from './schema';
import type {
  TenantWebhookConfigRepository,
  TenantWebhookConfigRepositoryError,
  InsertConfigInput,
  RotateSecretInput,
} from '../application/ports/tenant-webhook-config-repository';
import type { TenantWebhookConfigAggregate } from '../domain/tenant-webhook-config';
import type { WebhookSecret } from '../domain/branded-types';
import type { Source } from '../domain/value-objects/source';
import { wrapRepoError } from './sanitize-db-error';
import type { TenantId } from '@/modules/members';

function toAggregate(row: TenantWebhookConfigRow): TenantWebhookConfigAggregate {
  return {
    tenantId: row.tenantId as TenantId,
    source: row.source as Source,
    activeSecret: row.webhookSecretActive as WebhookSecret,
    graceSecret: row.webhookSecretGrace as WebhookSecret | null,
    graceRotatedAt: row.graceRotatedAt ? new Date(row.graceRotatedAt) : null,
    enabled: row.enabled,
    createdAt: new Date(row.createdAt),
    lastReceivedAt: row.lastReceivedAt ? new Date(row.lastReceivedAt) : null,
    lastRotatedAt: row.lastRotatedAt ? new Date(row.lastRotatedAt) : null,
  };
}

export function makeDrizzleTenantWebhookConfigRepository(
  executor: TenantTx,
): TenantWebhookConfigRepository {
  return {
    async insert(
      input: InsertConfigInput,
    ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>> {
      try {
        // ON CONFLICT DO NOTHING — returns empty array on duplicate.
        // The conflict target is the PK `(tenant_id, source)`.
        const inserted = await executor
          .insert(tenantWebhookConfigs)
          .values({
            tenantId: input.tenantId,
            source: input.source,
            webhookSecretActive: input.activeSecret,
            // grace columns + last_received_at + last_rotated_at all
            // default to NULL; `enabled` defaults to TRUE per schema.
          })
          .onConflictDoNothing({
            target: [tenantWebhookConfigs.tenantId, tenantWebhookConfigs.source],
          })
          .returning();

        if (inserted.length === 0) {
          return err({
            kind: 'already_exists',
            tenantId: input.tenantId,
            source: input.source,
          });
        }
        return ok(toAggregate(inserted[0]!));
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },

    async findByTenantSource(
      tenantId: TenantId,
      source: Source,
    ): Promise<
      Result<TenantWebhookConfigAggregate | null, TenantWebhookConfigRepositoryError>
    > {
      try {
        const rows = await executor
          .select()
          .from(tenantWebhookConfigs)
          .where(
            and(
              eq(tenantWebhookConfigs.tenantId, tenantId),
              eq(tenantWebhookConfigs.source, source),
            ),
          )
          .limit(1);
        if (rows.length === 0) return ok(null);
        return ok(toAggregate(rows[0]!));
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },

    async rotateSecret(
      input: RotateSecretInput,
    ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>> {
      try {
        // Phase 5 review-fix S-08 (2026-05-13) — per-(tenant) advisory
        // lock before the rotation UPDATE. The lock is held for the
        // duration of the current transaction (auto-released on
        // COMMIT/ROLLBACK) and serialises concurrent rotates from two
        // admin tabs so the second one observes the FIRST rotation's
        // grace before issuing its own. Without this, both UPDATEs
        // race and the older grace value can be lost (the second
        // rotation's column-list RHS picks up the new active, not
        // the original).
        //
        // Namespace `eventcreate:rotate-secret:<tenant>:<source>` is
        // disjoint from F4 `invoicing:`, F5 `payments:`, and F7
        // `broadcasts:` keyspaces so no cross-feature contention.
        // The rate-limit (3/hour) is the primary gate; this lock is
        // belt-and-braces. `hashtextextended(_, 0)` produces a stable
        // 64-bit signed integer suitable for pg_advisory_xact_lock.
        await executor.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`eventcreate:rotate-secret:${input.tenantId}:${input.source}`}, 0))`,
        );

        // Atomic active→grace + new active in ONE UPDATE so concurrent
        // webhook deliveries either see (old active + null grace) or
        // (new active + old as grace) — never (old active + old grace)
        // which would be a transient half-state. Postgres column-list
        // RHS expressions read the row's PRE-UPDATE values, so
        // `webhook_secret_grace = tenantWebhookConfigs.webhookSecretActive`
        // captures the previous active value before it gets overwritten.
        const updated = await executor
          .update(tenantWebhookConfigs)
          .set({
            webhookSecretGrace: tenantWebhookConfigs.webhookSecretActive,
            webhookSecretActive: input.newActiveSecret,
            graceRotatedAt: input.now,
            lastRotatedAt: input.now,
          })
          .where(
            and(
              eq(tenantWebhookConfigs.tenantId, input.tenantId),
              eq(tenantWebhookConfigs.source, input.source),
            ),
          )
          .returning();

        if (updated.length === 0) {
          return err({
            kind: 'not_found',
            tenantId: input.tenantId,
            source: input.source,
          });
        }
        return ok(toAggregate(updated[0]!));
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },

    async setEnabled(
      tenantId: TenantId,
      source: Source,
      enabled: boolean,
    ): Promise<Result<TenantWebhookConfigAggregate, TenantWebhookConfigRepositoryError>> {
      try {
        const updated = await executor
          .update(tenantWebhookConfigs)
          .set({ enabled })
          .where(
            and(
              eq(tenantWebhookConfigs.tenantId, tenantId),
              eq(tenantWebhookConfigs.source, source),
            ),
          )
          .returning();

        if (updated.length === 0) {
          return err({ kind: 'not_found', tenantId, source });
        }
        return ok(toAggregate(updated[0]!));
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },

    async touchLastReceivedAt(
      tenantId: TenantId,
      source: Source,
      receivedAt: Date,
    ): Promise<Result<void, TenantWebhookConfigRepositoryError>> {
      try {
        const updated = await executor
          .update(tenantWebhookConfigs)
          .set({ lastReceivedAt: receivedAt })
          .where(
            and(
              eq(tenantWebhookConfigs.tenantId, tenantId),
              eq(tenantWebhookConfigs.source, source),
            ),
          )
          .returning({ tenantId: tenantWebhookConfigs.tenantId });

        if (updated.length === 0) {
          return err({ kind: 'not_found', tenantId, source });
        }
        return ok(undefined);
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },

    async clearExpiredGrace(
      tenantId: TenantId,
      olderThan: Date,
    ): Promise<Result<number, TenantWebhookConfigRepositoryError>> {
      try {
        const updated = await executor
          .update(tenantWebhookConfigs)
          .set({
            webhookSecretGrace: null,
            graceRotatedAt: null,
          })
          .where(
            and(
              eq(tenantWebhookConfigs.tenantId, tenantId),
              // Only `eventcreate` source has grace rows in F6; the
              // `source` predicate is harmless if other sources are
              // added later (they simply won't match if they don't
              // populate `grace_rotated_at`). Pin to `'eventcreate'`
              // explicitly so a future schema migration that adds a
              // second source doesn't accidentally clear unrelated
              // grace rows.
              eq(tenantWebhookConfigs.source, 'eventcreate'),
              lt(tenantWebhookConfigs.graceRotatedAt, olderThan),
            ),
          )
          .returning({ tenantId: tenantWebhookConfigs.tenantId });

        return ok(updated.length);
      } catch (e) {
        return err(wrapRepoError('tenantWebhookConfig', e));
      }
    },
  };
}
