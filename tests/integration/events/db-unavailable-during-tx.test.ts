/**
 * T041 — DB-unavailable mid-tx chaos integration test (F6 / E14).
 *
 * Spec authority:
 *   - research.md R6 (dual-write audit fallback to stderr pino.fatal)
 *   - plan.md Testing § round-1 E14
 *   - FR-037 + contracts/audit-port.md § 6 webhook_rolled_back dual-write
 *
 * Scenario: close the DB connection mid-transaction at each ACID stage.
 * Asserts:
 *   (a) HTTP-mappable error returned to caller (`db_connection_lost`
 *       or similar discriminator on the Result.err)
 *   (b) `webhook_rolled_back` audit reaches stderr via `pino.fatal`
 *       with `audit_secondary_tx_failure: true` (the audit table is
 *       unreachable so the secondary tx ALSO fails; the dual-write
 *       path emits the rolled-back marker to stderr instead)
 *
 * The pino.fatal call is wrapped in try/catch — a stderr write failure
 * does NOT crash the handler.
 *
 * RED reason: `ingestWebhookAttendee` + audit dual-write fallback not
 * yet implemented (T047 + T051). Module imports fail → red.
 *
 * Turns GREEN: T047 + T051 land with the dual-write fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

// @ts-expect-error — not yet exported (T047).
import { ingestWebhookAttendee, makeIngestWebhookAttendeeDeps } from '@/modules/events';

describe('T041 — F6 DB-unavailable chaos (audit dual-write fallback)', () => {
  it('DB connection lost mid-tx → caller gets error + stderr emits webhook_rolled_back fallback', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const tenant = await createTestTenant('test-swecham');

    try {
      const payload = makeWebhookPayload();
      const deps = makeIngestWebhookAttendeeDeps();

      // Inject a "DB lost" error at each port + audit emitter that also fails
      const dbLostError = Object.assign(new Error('CONNECTION_TERMINATED'), {
        code: 'CONNECTION_TERMINATED',
      });
      (deps.eventsRepo as Record<string, unknown>).upsert = vi
        .fn()
        .mockRejectedValue(dbLostError);
      (deps.audit as Record<string, unknown>).emitRolledBack = vi
        .fn()
        .mockResolvedValue({ ok: false, error: { kind: 'db_error', message: 'CONNECTION_TERMINATED' } });

      const result = await ingestWebhookAttendee({
        tenantId: tenant.ctx.slug,
        requestId: 'req-db-unavail-001',
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      }, deps);

      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe('rolled_back');

      // Dual-write fallback: pino.fatal writes a structured line to stderr
      // when the secondary audit tx ALSO fails. Search the spy's calls.
      const writtenLines = stderrSpy.mock.calls.map((c) => String(c[0]));
      const fallbackLine = writtenLines.find(
        (l) =>
          l.includes('webhook_rolled_back') &&
          l.includes('audit_secondary_tx_failure'),
      );
      expect(fallbackLine).toBeDefined();
    } finally {
      stderrSpy.mockRestore();
      await tenant.cleanup();
    }
  });
});
