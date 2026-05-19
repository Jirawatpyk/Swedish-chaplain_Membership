/**
 * Integration test for `pino-audit-port.emitStandalone`.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import { asTenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { TenantTx } from '@/lib/db';

/**
 * Round 2 T-Gap6 fix (2026-05-13) — single-purpose helper that owns
 * the cast from a system-sentinel string to the audit-port's
 * `actorUserId` brand. Replaces the previous brittle triple-cast
 * chain (`as ReturnType<typeof asTenantId> & string as unknown as
 * ...`) which incorrectly went through `asTenantId` and would silently
 * rot if that brand is renamed. Branded `actorUserId` accepts `UserId`
 * which is `string & { __brand: 'UserId' }` — the `as` here is the
 * standard branded-cast pattern at the trust boundary.
 */
type SystemActorUserId = Parameters<
  ReturnType<typeof makePinoAuditPort>['emitStandalone']
>[0]['actorUserId'];
function asTestSystemActorUserId(value: `system:${string}`): SystemActorUserId {
  return value as unknown as SystemActorUserId;
}

describe('pino-audit-port.emitStandalone', () => {
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

  it('slug-shape regex guard rejects malformed tenantId (SQL injection defence) + logFullError preserves stack', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
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
    // R10.3 / QA F-3 closure — assertion aligned with actual
    // `InvalidTenantSlugError` message format at
    // `src/modules/tenants/domain/tenant-context.ts:51-52` which
    // produces: "Invalid tenant slug: ... Must match [a-z0-9-]{1,63}
    // (lowercase alphanumeric + hyphen, 1..63 chars)."
    // Defensive code is unchanged — only the test expectation aligned.
    expect(result.error.message).toMatch(/Invalid tenant slug|Must match \[a-z0-9-\]/);
    // logFullError preserves the unsanitised error name + stack server-side
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emitStandalone',
        err: expect.objectContaining({
          name: expect.any(String),
          message: expect.stringMatching(/Invalid tenant slug|Must match \[a-z0-9-\]/),
        }),
      }),
      expect.any(String),
    );
    errorSpy.mockRestore();
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

  /**
   * Round-3 verify-fix (2026-05-13) — `webhook_test_invoked` payload
   * previously used `testRequestId` instead of `requestId`. Before the
   * fix, `extractRequestId()` only checked `payload.requestId` and the
   * test-webhook short-circuit's audit row landed with `request_id =
   * 'no-request-id'` (sentinel), masking the real test correlation
   * key in the admin recent-deliveries panel.
   *
   * Round-6 verify-fix 2026-05-13 (type-design C2) renamed the field
   * to `requestId` (now branded `RequestId`) for naming-convention
   * symmetry across all F6 webhook audit event types. The legacy
   * `testRequestId` fallback in `extractRequestId()` stays so old
   * audit rows (emitted in dev/staging pre-rename) still hydrate.
   * This test now asserts BOTH the new canonical path AND the legacy
   * fallback continue to populate `audit_log.request_id` correctly.
   */
  it('webhook_test_invoked — payload.requestId populates audit_log.request_id (new canonical path)', async () => {
    const t = await createTestTenant('test-chamber');
    try {
      const dummyExecutor = {
        execute: () => {
          throw new Error('not reached');
        },
      } as unknown as TenantTx;
      const port = makePinoAuditPort(dummyExecutor);

      const requestId = `test-${Date.now()}-extract-mapping-new`;
      // Round 2 T-Gap6 fix (2026-05-13) — replace the brittle triple-
      // cast (`as ReturnType<typeof asTenantId> & string as unknown
      // as ...`) with a single, semantically-correct
      // `asTestSystemActorUserId()` helper. The previous chain went
      // through `asTenantId`, which is the wrong brand — would silently
      // rot if `asTenantId` is renamed or removed.
      const actorUserId = asTestSystemActorUserId('system:f6-test-webhook');

      // Cast the entire payload object to bypass the audit-port's
      // discriminated-union schema — the integration test exercises
      // the on-disk JSONB column shape, which is free-form at the
      // Drizzle adapter level. Production callers use the typed
      // entry path (see `route.ts:665+` for the canonical site).
      const payload = {
        severity: 'info' as const,
        actorUserId,
        requestId,
        durationMs: 42,
      } as unknown as Parameters<typeof port.emitStandalone>[0]['payload'];

      const result = await port.emitStandalone({
        eventType: 'webhook_test_invoked',
        tenantId: asTenantId(t.ctx.slug),
        actorType: 'system',
        actorUserId,
        occurredAt: new Date(),
        summary: 'extract-mapping integration test (new path)',
        payload,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('emitStandalone should succeed');

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug));
      const ours = rows.filter(
        (r) =>
          (r.eventType as string) === 'webhook_test_invoked' &&
          (r.payload as Record<string, unknown> | null)?.['requestId'] ===
            requestId,
      );
      expect(ours).toHaveLength(1);
      // Critical assertion — `request_id` column must equal the
      // `requestId` payload field, NOT the 'no-request-id' sentinel.
      expect(ours[0]!.requestId).toBe(requestId);
    } finally {
      await t.cleanup();
    }
  });

  /**
   * Legacy-fallback path: old audit rows emitted with the bespoke
   * `testRequestId` field name must still hydrate `request_id`
   * correctly. Guards against accidentally removing the fallback
   * branch in `extractRequestId()` before all pre-rename dev/staging
   * audit rows have expired beyond retention.
   *
   * Type-system note: bypass the (now strict) audit-port TS schema
   * via a casted variant since the production payload contract no
   * longer accepts `testRequestId`. The Drizzle adapter accepts any
   * JSONB payload at runtime; the fallback in `extractRequestId()`
   * is unit-tested against this on-disk shape directly.
   */
  it('webhook_test_invoked — legacy payload.testRequestId fallback still populates request_id', async () => {
    const t = await createTestTenant('test-chamber');
    try {
      const dummyExecutor = {
        execute: () => {
          throw new Error('not reached');
        },
      } as unknown as TenantTx;
      const port = makePinoAuditPort(dummyExecutor);

      const legacyTestRequestId = `test-${Date.now()}-extract-mapping-legacy`;
      const actorUserId = asTestSystemActorUserId('system:f6-test-webhook');
      // Cast through `as never` because the post-C2 audit-port schema
      // rejects the legacy `testRequestId` field — but the Drizzle
      // adapter doesn't enforce the schema at runtime (JSONB is
      // free-form), so this test exercises the fallback as it would
      // fire against an old on-disk audit row.
      const legacyPayload = {
        severity: 'info' as const,
        actorUserId,
        testRequestId: legacyTestRequestId,
        durationMs: 42,
      } as unknown as Parameters<typeof port.emitStandalone>[0]['payload'];

      const result = await port.emitStandalone({
        eventType: 'webhook_test_invoked',
        tenantId: asTenantId(t.ctx.slug),
        actorType: 'system',
        actorUserId,
        occurredAt: new Date(),
        summary: 'extract-mapping integration test (legacy path)',
        payload: legacyPayload,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('emitStandalone should succeed');

      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug));
      const ours = rows.filter(
        (r) =>
          (r.eventType as string) === 'webhook_test_invoked' &&
          (r.payload as Record<string, unknown> | null)?.['testRequestId'] ===
            legacyTestRequestId,
      );
      expect(ours).toHaveLength(1);
      expect(ours[0]!.requestId).toBe(legacyTestRequestId);
    } finally {
      await t.cleanup();
    }
  });
});
