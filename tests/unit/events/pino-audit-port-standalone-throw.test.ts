/**
 * Phase H4.4 / NEW-S3 — Pin the A1 (Round 1) `runInTenant` refactor's
 * synchronous-throw behaviour for `pino-audit-port.emitStandalone` +
 * `emitRolledBack`.
 *
 * The A1 refactor replaced the prior `sql.raw()` + manual GUC SET
 * with `runInTenant(asTenantContext(String(entry.tenantId)), ...)`.
 * `asTenantContext` THROWS synchronously on a malformed slug BEFORE
 * the async `runInTenant` callback fires. The outer try/catch must
 * catch this synchronous throw so the dual-write fallback chain
 * (`pino.fatal` + stderr last-ditch) still produces a forensic
 * breadcrumb.
 *
 * Without this regression test, a future refactor that moves the
 * `String(...)` coercion or wraps it in a Promise could quietly break
 * the catch chain and silently lose the FR-037 audit trail invariant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stderrWriteSpy = vi
  .spyOn(process.stderr, 'write')
  .mockImplementation(() => true);

const fatalSpy = vi.fn();
const errorSpy = vi.fn();

vi.mock('@/lib/logger', () => ({
  logger: {
    fatal: fatalSpy,
    error: errorSpy,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  fatalSpy.mockReset();
  errorSpy.mockReset();
  stderrWriteSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('H4.4 — pino-audit-port standalone throw-chain regression', () => {
  it('emitStandalone catches synchronous asTenantContext throw + returns Result.err + fires fatal log', async () => {
    const { makePinoAuditPort } = await import(
      '@/modules/events/infrastructure/pino-audit-port'
    );
    const port = makePinoAuditPort(null as never); // executor unused in standalone path

    const result = await port.emitStandalone({
      eventType: 'webhook_signature_rejected',
      tenantId: 'tenant with spaces' as never, // malformed slug — asTenantContext throws
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'malformed slug regression probe',
      payload: {
        severity: 'warn',
        requestId: null,
        sourceIp: '127.0.0.1',
        signatureLastFour: null,
        timestampSkewSeconds: 0,
        bodyLengthBytes: 0,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('db_error');
    }
    // pino.fatal MUST fire — this is the FR-037 dual-write fallback.
    expect(fatalSpy).toHaveBeenCalled();
    const fatalCall = fatalSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(fatalCall?.['audit_secondary_tx_failure']).toBe(true);
    expect(fatalCall?.['event']).toBe('webhook_signature_rejected');
  });

  it('emitRolledBack catches synchronous asTenantContext throw + returns Result.err + fires fatal log', async () => {
    const { makePinoAuditPort } = await import(
      '@/modules/events/infrastructure/pino-audit-port'
    );
    const port = makePinoAuditPort(null as never);

    const result = await port.emitRolledBack({
      eventType: 'webhook_rolled_back',
      tenantId: 'TENANT WITH UPPERCASE' as never, // also malformed — slug pattern is lowercase
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'malformed slug regression probe',
      payload: {
        severity: 'error',
        requestId: 'req-malformed-slug',
        source: 'eventcreate',
        failureStage: 'audit_emit',
        errorMessage: 'malformed-slug invariant probe',
        errorStack: null,
      },
    });

    expect(result.ok).toBe(false);
    expect(fatalSpy).toHaveBeenCalled();
    const fatalCall = fatalSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(fatalCall?.['audit_secondary_tx_failure']).toBe(true);
    expect(fatalCall?.['event']).toBe('webhook_rolled_back');
  });
});
