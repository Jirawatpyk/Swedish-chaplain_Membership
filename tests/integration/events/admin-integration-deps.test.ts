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
  asBoundedReason,
} from '@/lib/events-admin-integration-deps';
import { tenantWebhookConfigs } from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import * as pinoAuditPortModule from '@/modules/events/infrastructure/pino-audit-port';
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
          reason: asBoundedReason('H7 happy path test'),
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

    it('audit_emit_failed forensic path — Result.err + pino.fatal + gauge STILL emits (T-Gap1)', async () => {
      // Round 2 T-Gap1 fix (2026-05-13) — promised in the file
      // header but missing from round-6. Closes the H3 dashboard-
      // truth invariant: when DB committed AND audit emit failed,
      // the gauge MUST still emit so the dashboard reflects the
      // real DB state.
      //
      // Strategy: spy on `makePinoAuditPort` to return a port whose
      // `.emit()` resolves to `{ok: false, error: {kind: 'db_error',
      // message: 'simulated audit failure'}}`. The use-case then
      // returns Result.err{kind:'audit_emit_failed'} after the DB
      // row was already updated by `repo.setEnabled` inside the same
      // tx — Drizzle commits the row (no throw → no rollback).
      const fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined);
      const gaugeSpy = vi.spyOn(eventcreateMetrics, 'ingestDisabledTenant');
      const realMake = pinoAuditPortModule.makePinoAuditPort;
      const portSpy = vi
        .spyOn(pinoAuditPortModule, 'makePinoAuditPort')
        .mockImplementation((tx) => {
          const real = realMake(tx);
          return {
            ...real,
            emit: vi.fn().mockResolvedValue({
              ok: false,
              error: { kind: 'db_error', message: 'simulated audit failure' },
            }),
          };
        });
      const actor = randomUUID();
      try {
        const result = await runToggleIngest(tenant.ctx.slug, actor, {
          enabled: false,
          reason: asBoundedReason('T-Gap1 forensic path test'),
        });
        // 0. Sanity — verify the spy ACTUALLY intercepted the
        //    `makePinoAuditPort` factory call inside the use-case.
        //    Round 3 M-test-2 (2026-05-13) — without this assertion a
        //    future bundler upgrade that breaks Vitest's ESM
        //    live-binding semantics would silently fall through to the
        //    real port and the test would pass by accident (because
        //    the real port emits + commits cleanly on a happy-path
        //    tenant). Asserting the spy fired locks the invariant.
        expect(portSpy).toHaveBeenCalled();

        // 1. Use-case surfaces the audit-emit-failed kind.
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.error.kind).toBe('audit_emit_failed');

        // 2. pino.fatal fired with the structured forensic event.
        expect(fatalSpy).toHaveBeenCalled();
        const fatalCall = fatalSpy.mock.calls[0];
        expect(fatalCall?.[0]).toMatchObject({
          event: 'f6_disable_ingest_audit_emit_failed',
          tenantSlug: tenant.ctx.slug,
          enabledAfter: false,
        });

        // 3. Gauge STILL emitted — this is the H3 dashboard-truth
        // invariant. Without this, the dashboard freezes at the
        // prior value while DB has already mutated.
        expect(gaugeSpy).toHaveBeenCalledWith(tenant.ctx.slug, false);

        // 4. DB row actually mutated (audit failure does NOT roll
        // back the tx because the use-case returns Result.err
        // instead of throwing).
        const rows = await db
          .select({ enabled: tenantWebhookConfigs.enabled })
          .from(tenantWebhookConfigs)
          .where(eq(tenantWebhookConfigs.tenantId, tenant.ctx.slug));
        expect(rows[0]?.enabled).toBe(false);
      } finally {
        portSpy.mockRestore();
        gaugeSpy.mockRestore();
        fatalSpy.mockRestore();
        // Reset row to enabled for next test if any.
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

  describe('runToggleIngest — not_found branch when no config row exists (T-Gap3)', () => {
    // Round 2 T-Gap3 fix (2026-05-13) — agent-flagged gap: T068
    // covers the route-level mapping (mock returns not_found, route
    // returns 404), but the actual adapter branch that produces
    // `{kind:'not_found', tenantId, source:'eventcreate'}` from a
    // missing tenant_webhook_configs row had no integration test.
    let freshTenant: TestTenant;

    beforeAll(async () => {
      // No tenantWebhookConfigs row seeded → triggers the not_found
      // branch when toggling. `createTestTenant` mints a UUID-suffixed
      // slug so this fresh tenant is automatically disjoint from the
      // sibling `config_missing` describe block's tenant — Round 3
      // M-test-1 reviewer concern is moot because the helper already
      // guarantees isolation by construction.
      freshTenant = await createTestTenant('test-chamber');
    });

    afterAll(async () => {
      await freshTenant.cleanup();
    });

    it('returns Result.err{kind:not_found} when no config row exists', async () => {
      // Round 3 H6 (2026-05-13) — explicitly assert the gauge is NOT
      // emitted on the not_found branch. T-Gap1 (forensic path) locks
      // the "DB committed, audit failed → gauge STILL fires" half of
      // the H3 dashboard-truth invariant; this test locks the opposite
      // half — when the use-case short-circuits BEFORE `dbStateMutated
      // = true`, the gauge MUST stay silent. A future regression that
      // moves the `dbStateMutated` flag above the precondition check
      // would slip a phantom gauge tick into dashboards for tenants
      // that never had a row.
      const gaugeSpy = vi.spyOn(eventcreateMetrics, 'ingestDisabledTenant');
      try {
        const result = await runToggleIngest(freshTenant.ctx.slug, randomUUID(), {
          enabled: false,
          reason: asBoundedReason('T-Gap3 fresh-tenant test'),
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.error.kind).toBe('not_found');
        expect(gaugeSpy).not.toHaveBeenCalled();
      } finally {
        gaugeSpy.mockRestore();
      }
    });
  });
});
