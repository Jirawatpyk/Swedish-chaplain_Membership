/**
 * T041 — DB-unavailable mid-tx chaos integration test (F6 / E14).
 *
 * Spec authority:
 *   - research.md R6 (dual-write audit fallback to stderr pino.fatal)
 *   - plan.md Testing § round-1 E14
 *   - FR-037 + contracts/audit-port.md § 6 webhook_rolled_back dual-write
 *
 * Simulates BOTH the primary tx (runInTenantTx) AND the secondary
 * standalone-emitter tx failing due to DB being unreachable. Asserts:
 *   (a) HTTP-mappable error returned to caller (Result.err{kind:'rolled_back'})
 *   (b) `webhook_rolled_back` audit reaches stderr via `pino.fatal`
 *       with `audit_secondary_tx_failure: true` — preserving
 *       observability even when the DB is fully down (Vercel Fluid
 *       Compute captures stderr as runtime logs).
 *
 * Strategy: spy on `db.transaction` to throw. The use-case's
 * `runInTenantTx` call fails → catch fires → `emitRolledBackStandalone`
 * also fails (same spy intercepts the secondary tx) → pino.fatal
 * writes to stderr → assertion confirms.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as dbModule from '@/lib/db';
import { logger } from '@/lib/logger';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

describe('T041 — F6 DB-unavailable chaos (audit dual-write fallback)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DB connection lost mid-tx → caller gets rolled_back error + pino.fatal called with audit_secondary_tx_failure marker', async () => {
    // pino uses `sonic-boom` for fast writes, which calls `fs.writeSync`
    // directly to the stdout fd — bypassing `process.stdout.write`. Spy
    // directly on `logger.fatal` instead; this is the dual-write fallback
    // entry point per `pino-audit-port.ts` `emitRolledBack` catch block.
    const fatalSpy = vi.spyOn(logger, 'fatal');
    // Both the primary `runInTenantTx` tx AND the secondary
    // `emitRolledBackStandalone` tx use `db.transaction(...)`. Spy on it
    // to throw — simulates Neon connection loss mid-flight.
    const txSpy = vi
      .spyOn(dbModule.db, 'transaction')
      .mockRejectedValue(
        Object.assign(new Error('CONNECTION_TERMINATED'), { code: 'CONNECTION_TERMINATED' }),
      );

    const deps = makeIngestWebhookAttendeeDeps();
    const result = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId: `req-db-unavail-${Date.now()}`,
        source: 'eventcreate_webhook',
        rawPayload: makeWebhookPayload(),
        sourceIp: '127.0.0.1',
      },
      deps,
    );

    // Caller sees a rolled_back error.
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe('rolled_back');
    }

    // Both tx attempts were tried (primary + standalone audit fallback).
    expect(txSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Dual-write fallback (research.md R6): `pino.fatal` is called with
    // a structured object containing `audit_secondary_tx_failure: true`
    // and the rollback payload — Vercel Fluid Compute captures stdout
    // (where pino writes by default) as runtime logs so the marker is
    // never invisible at the observability layer.
    expect(fatalSpy).toHaveBeenCalled();
    const matchingCall = fatalSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'webhook_rolled_back' &&
        (call[0] as Record<string, unknown>)['audit_secondary_tx_failure'] === true,
    );
    expect(matchingCall).toBeDefined();

    // Cleanup — restore spies BEFORE the tenant cleanup runs (which
    // needs db.transaction to work).
    fatalSpy.mockRestore();
    txSpy.mockRestore();
    await tenant.cleanup();
  });
});
