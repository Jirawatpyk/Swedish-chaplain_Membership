/**
 * T120 integration test — `tenant_invoice_settings_cross_tenant_probe`.
 *
 * The PATCH handler's host-vs-deployed-slug dual-bind check is dormant
 * today (STD deployment — `resolveTenantFromRequest` hard-codes to
 * `env.tenant.slug` so the two slugs always match). This test
 * exercises the PROBE EMIT PATH directly against the live-Neon
 * audit_log to prove:
 *
 *   1. Migration 0031 registered `tenant_invoice_settings_cross_tenant_probe`
 *      in the `audit_event_type` Postgres enum.
 *   2. `f4AuditAdapter.emit(null, { eventType: 'tenant_invoice_settings_cross_tenant_probe', ... })`
 *      round-trips end-to-end (INSERT → SELECT on the correct
 *      request-id correlation).
 *
 * A behavioral test of the PATCH handler's 403-on-mismatch branch is
 * not shipped here because STD's resolver cannot produce a mismatch —
 * mocking it would test the mock, not the guard. When F10 MTA lands,
 * this file gains a route-level mismatch test against the real
 * subdomain resolver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('T120 — tenant_invoice_settings_cross_tenant_probe (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('probe emit round-trips to audit_log with correct payload shape', async () => {
    const requestId = `t120-${randomUUID()}`;
    const hostResolvedSlug = 'tscc-probe-fake';
    const deployedSlug = tenant.ctx.slug;

    await f4AuditAdapter.emit(null, {
      tenantId: tenant.ctx.slug,
      requestId,
      eventType: 'tenant_invoice_settings_cross_tenant_probe',
      actorUserId: user.userId,
      summary: `Cross-tenant probe on tenant-invoice-settings (host=${hostResolvedSlug}, deployed=${deployedSlug})`,
      payload: {
        host_resolved_slug: hostResolvedSlug,
        deployed_slug: deployedSlug,
        route: 'PATCH /api/tenant-invoice-settings',
      },
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tenant_invoice_settings_cross_tenant_probe'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.host_resolved_slug).toBe(hostResolvedSlug);
    expect(payload.deployed_slug).toBe(deployedSlug);
    expect(payload.route).toBe('PATCH /api/tenant-invoice-settings');
  }, 30_000);
});
