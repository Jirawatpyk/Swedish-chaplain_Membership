/**
 * Integration test for `pino-audit-port.emitStandalone` (gap-2 from
 * /speckit-review).
 *
 * Covers behaviours of the standalone-tx audit path that the route
 * handler uses for `webhook_signature_rejected` (and now also the
 * config-load-failed branch):
 *   1. Happy path — audit row committed; Result.ok with id
 *   2. Slug-shape regex guard — invalid tenant slug throws BEFORE the
 *      raw SQL `SET LOCAL app.current_tenant = '${tenantId}'` line
 *      (SQL-injection defence-in-depth)
 *   3. Row carries the correct tenant_id (RLS context applied)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import { asTenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { TenantTx } from '@/lib/db';

describe('pino-audit-port.emitStandalone — gap-2', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-chamber');
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('happy path — webhook_signature_rejected row committed in separate tx', async () => {
    // Standalone path doesn't use the tx-bound executor — pass a dummy
    // that throws if `.execute` is ever reached (it shouldn't on this
    // code path).
    const dummyExecutor = {
      execute: () => {
        throw new Error('dummy tx-bound executor should never be reached on emitStandalone');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(dummyExecutor);

    const result = await port.emitStandalone({
      eventType: 'webhook_signature_rejected',
      tenantId: asTenantId(tenant.ctx.slug),
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'emit-standalone integration test',
      payload: {
        severity: 'warn',
        requestId: 'req-emit-standalone-test',
        sourceIp: '127.0.0.1',
        signatureLastFour: 'abcd',
        timestampSkewSeconds: null,
        bodyLengthBytes: 42,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('emitStandalone should succeed');

    // Confirm row landed with the right tenant_id (RLS context applied)
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const ours = rows.filter(
      (r) =>
        (r.eventType as string) === 'webhook_signature_rejected' &&
        (r.payload as Record<string, unknown> | null)?.['requestId'] ===
          'req-emit-standalone-test',
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]!.tenantId).toBe(tenant.ctx.slug);
  });

  it('slug-shape regex guard rejects malformed tenantId (SQL injection defence)', async () => {
    const dummyExecutor = {
      execute: () => {
        throw new Error('not reached');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(dummyExecutor);

    // tenantId with an apostrophe — classic injection probe
    const maliciousTenantId = "evil'; DROP TABLE audit_log; --";
    const result = await port.emitStandalone({
      eventType: 'webhook_signature_rejected',
      // Cast bypasses TS branding — simulates a future caller that
      // skips `asTenantId` validation.
      tenantId: maliciousTenantId as unknown as ReturnType<typeof asTenantId>,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'emit-standalone slug guard test',
      payload: {
        severity: 'warn',
        requestId: 'req-slug-guard-test',
        sourceIp: '127.0.0.1',
        signatureLastFour: 'evil',
        timestampSkewSeconds: null,
        bodyLengthBytes: 0,
      },
    });

    // The guard throws inside the try {…} block — the catch converts
    // it to a Result.err.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    // The sanitised message must mention the slug-invariant
    expect(result.error.message).toMatch(/slug invariant violated/);
  });

  it('valid slug accepted (control case)', async () => {
    const okTenant = await createTestTenant('test-chamber');
    try {
      const dummyExecutor = {
        execute: () => {
          throw new Error('not reached');
        },
      } as unknown as TenantTx;
      const port = makePinoAuditPort(dummyExecutor);

      const result = await port.emitStandalone({
        eventType: 'webhook_signature_rejected',
        tenantId: asTenantId(okTenant.ctx.slug),
        actorType: 'zapier_webhook',
        actorUserId: null,
        occurredAt: new Date(),
        summary: 'emit-standalone 63-char boundary test',
        payload: {
          severity: 'warn',
          requestId: 'req-63char-boundary',
          sourceIp: '127.0.0.1',
          signatureLastFour: null,
          timestampSkewSeconds: null,
          bodyLengthBytes: 0,
        },
      });

      expect(result.ok).toBe(true);
    } finally {
      await okTenant.cleanup();
    }
  });
});
