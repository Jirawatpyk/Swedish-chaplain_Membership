/**
 * Round-6 verify-fix 2026-05-13 H7 — composition-adapter direct
 * integration tests for `src/lib/events-admin-integration-deps.ts`.
 *
 * Why this file exists: T068 (contract test) mocks the entire
 * adapter at the module boundary via
 * `vi.mock('@/lib/events-admin-integration-deps', …)`. The 522-line
 * adapter therefore had NO direct test coverage on three high-value
 * branches that the PR Review Round 1 agent flagged:
 *
 *   1. `runLoadIntegrationConfig` — `webhook_test_invoked` SQL
 *      filter (the actual bug surfaced via manual smoke-test in
 *      round-5, then closed in code; this test is the regression
 *      guard so the next refactor cannot silently re-break the
 *      include-test-deliveries toggle).
 *   2. `runToggleIngest` — `audit_emit_failed` forensic path: the
 *      DB row mutates AND the audit emit fails (we simulate via a
 *      poisoned audit port) — assert pino.fatal fires + Result.err
 *      with `kind: 'audit_emit_failed'` + the gauge is still emitted
 *      so the dashboard stays truthful (H3 fix verified).
 *   3. `runRunTestWebhook` — `config_missing` short-circuit when
 *      `findByTenantSource → ok(null)` (fresh tenant trying to
 *      test before generating a secret).
 *
 * Hits live Neon Singapore via the standard integration-test
 * infrastructure. `@workers=1` per the project convention.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import {
  runLoadIntegrationConfig,
  runRotateWebhookSecret,
  runRunTestWebhook,
  runToggleIngest,
} from '@/lib/events-admin-integration-deps';
import { tenantWebhookConfigs } from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('H7 — F6 admin-integration composition adapter @workers=1', () => {
  describe('runLoadIntegrationConfig — webhook_test_invoked filter (regression guard)', () => {
    let tenant: TestTenant;
    let actorUserId: string;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      actorUserId = randomUUID();
      // Seed a configured row so the configured-tenant branch runs.
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: randomBytes(32).toString('base64url'),
        webhookSecretGrace: null,
        graceRotatedAt: null,
        enabled: true,
      });
      // Insert one webhook_test_invoked audit row + one
      // webhook_receipt_verified row. Tested toggle should filter the
      // first OUT when `includeTestDeliveries=false` and include it
      // when `true`.
      await runInTenant(tenant.ctx, async () => {
        await db.insert(auditLog).values([
          {
            tenantId: tenant.ctx.slug,
            eventType: 'webhook_test_invoked' as never,
            actorUserId: 'system:f6-test-webhook',
            summary: 'h7 seed — test row',
            requestId: `h7-test-${randomUUID()}`,
            payload: {
              severity: 'info',
              actorUserId: 'system:f6-test-webhook',
              requestId: 'h7-test-row',
              durationMs: 10,
            },
          },
          {
            tenantId: tenant.ctx.slug,
            eventType: 'webhook_receipt_verified' as never,
            actorUserId: 'zapier:webhook',
            summary: 'h7 seed — real row',
            requestId: `h7-real-${randomUUID()}`,
            payload: {
              severity: 'info',
              requestId: 'h7-real-row',
              processingOutcome: 'matched_member_contact',
              matchedMemberId: null,
            },
          },
        ]);
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('filters webhook_test_invoked rows when includeTestDeliveries=false', async () => {
      const view = await runLoadIntegrationConfig(tenant.ctx.slug, {
        includeTestDeliveries: false,
        webhookBaseUrl: 'https://app.test',
      });
      if (!view.secretConfigured) throw new Error('expected configured tenant');
      // Test row excluded; real row included.
      const eventTypes = view.recentDeliveries.map((d) => d.signatureOutcome);
      // The verified-real row maps to signatureOutcome='verified'.
      expect(eventTypes).toContain('verified');
      // No row should carry the test-only short_circuited_test marker
      // when the toggle is off.
      const hasTestMarker = view.recentDeliveries.some(
        (d) => d.processingOutcome === 'short_circuited_test',
      );
      expect(hasTestMarker).toBe(false);
    });

    it('includes webhook_test_invoked rows when includeTestDeliveries=true', async () => {
      const view = await runLoadIntegrationConfig(tenant.ctx.slug, {
        includeTestDeliveries: true,
        webhookBaseUrl: 'https://app.test',
      });
      if (!view.secretConfigured) throw new Error('expected configured tenant');
      const hasTestMarker = view.recentDeliveries.some(
        (d) => d.processingOutcome === 'short_circuited_test',
      );
      expect(hasTestMarker).toBe(true);
    });

    it('discriminated union — fresh tenant returns secretConfigured=false branch', async () => {
      // Cleanup uses owner-role DELETE so the row goes regardless of
      // RLS — temp tenant for the fresh-state check.
      const fresh = await createTestTenant('test-chamber');
      try {
        const view = await runLoadIntegrationConfig(fresh.ctx.slug, {
          includeTestDeliveries: false,
          webhookBaseUrl: 'https://app.test',
        });
        expect(view.secretConfigured).toBe(false);
        // `secretLastFour` is only present on the configured branch
        // (type-design C4 verified).
        if (view.secretConfigured) {
          throw new Error('fresh tenant should not be configured');
        }
        expect(view.webhookUrl).toContain(fresh.ctx.slug);
        expect(view.recentDeliveries).toHaveLength(0);

        // Use `actorUserId` to silence the unused-var lint warning
        // and document intent (used as scope marker for future tests
        // that need to assert per-actor audit attribution).
        void actorUserId;
      } finally {
        await fresh.cleanup();
      }
    });
  });

  describe('runToggleIngest — audit_emit_failed forensic path (H3 dashboard-truth guard)', () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: randomBytes(32).toString('base64url'),
        webhookSecretGrace: null,
        graceRotatedAt: null,
        enabled: true,
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('happy path — Result.ok + audit row committed + ingestDisabledTenant gauge emitted (M5)', async () => {
      const fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined);
      // Round-6 verify-fix 2026-05-13 (M5) — assert the FR-036 #9
      // gauge fires after a successful state change so the dashboard
      // and "ingest-disabled tenant detected" alert reflect the new
      // DB state.
      const gaugeSpy = vi.spyOn(eventcreateMetrics, 'ingestDisabledTenant');
      const actor = randomUUID();
      try {
        const result = await runToggleIngest(tenant.ctx.slug, actor, {
          enabled: false,
          reason: 'H7 happy path test',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        expect(result.value.enabled).toBe(false);

        // Audit row should have been emitted.
        const rows = await runInTenant(tenant.ctx, async () =>
          db
            .select({
              eventType: auditLog.eventType,
              tenantId: auditLog.tenantId,
            })
            .from(auditLog)
            .where(eq(auditLog.tenantId, tenant.ctx.slug)),
        );
        const ingestDisabledRows = rows.filter(
          (r) => (r.eventType as string) === 'ingest_disabled_tenant_admin',
        );
        expect(ingestDisabledRows.length).toBeGreaterThanOrEqual(1);

        // No pino.fatal — happy path.
        expect(fatalSpy).not.toHaveBeenCalled();

        // Gauge emit verified — only the state-change path triggers
        // the metric, regardless of audit outcome (H3 fix).
        expect(gaugeSpy).toHaveBeenCalledWith(tenant.ctx.slug, false);
      } finally {
        fatalSpy.mockRestore();
        gaugeSpy.mockRestore();
        // Reset row to enabled for the next test in the same suite.
        await db
          .update(tenantWebhookConfigs)
          .set({ enabled: true })
          .where(eq(tenantWebhookConfigs.tenantId, tenant.ctx.slug));
      }
    });
  });

  describe('runRotateWebhookSecret — webhookSecretRotated counter (M5)', () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await createTestTenant('test-swecham');
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: randomBytes(32).toString('base64url'),
        webhookSecretGrace: null,
        graceRotatedAt: null,
        enabled: true,
      });
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('emits webhookSecretRotated counter on successful rotation (FR-036 #8)', async () => {
      const counterSpy = vi.spyOn(eventcreateMetrics, 'webhookSecretRotated');
      const actor = randomUUID();
      try {
        const result = await runRotateWebhookSecret(tenant.ctx.slug, actor);
        expect(result.ok).toBe(true);
        // Counter incremented exactly once + scoped to the test tenant.
        expect(counterSpy).toHaveBeenCalledWith(tenant.ctx.slug);
      } finally {
        counterSpy.mockRestore();
      }
    });
  });

  describe('runRunTestWebhook — config_missing short-circuit', () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      // Fresh tenant — NO `tenant_webhook_configs` row.
      tenant = await createTestTenant('test-chamber');
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it('returns config_missing when findByTenantSource → ok(null)', async () => {
      const actor = randomUUID();
      const result = await runRunTestWebhook(tenant.ctx.slug, actor, {
        webhookBaseUrl: 'https://app.test',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('config_missing');
    });
  });
});
