/**
 * Unit tests for `safeEmitStandalone` shared helper (round-8 R8
 * review fix — closes the I-1 critical gap: the new shared
 * composition-layer primitive had zero direct tests, so its
 * contract — "audit failure MUST NEVER block the HTTP response" —
 * was unverifiable at the unit level and would silently regress on
 * any future refactor).
 *
 * Behavioural contract under test:
 *   1. Happy path: `emitStandalone` resolves → no logger.error.
 *   2. Audit-failure path: rejects with Error → logger.error fires
 *      once with structured fields (event/tenantSlug/errName/
 *      errMessage/errStack) AND redactStack scrubs container paths.
 *   3. Non-Error rejection: rejects with string → errName='unknown',
 *      errMessage='<string>', errStack=null.
 *   4. Return-void invariant: helper resolves (never throws) on
 *      either failure mode.
 *   5. logEvent / logMsg / tenantSlug values pass through verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import { safeEmitStandalone } from '@/lib/events-safe-emit-standalone';
import type {
  StandaloneAuditDeps,
  F6AuditEntry,
} from '@/modules/events';

function makeEntry(): F6AuditEntry<'cross_tenant_probe'> {
  return {
    eventType: 'cross_tenant_probe',
    tenantId: 'tenant-a' as F6AuditEntry<'cross_tenant_probe'>['tenantId'],
    actorType: 'admin',
    actorUserId: null,
    occurredAt: new Date('2026-05-13T10:00:00Z'),
    summary: 'unit test probe',
    payload: {
      severity: 'warn',
      probedTenantId:
        'tenant-a' as F6AuditEntry<'cross_tenant_probe'>['tenantId'],
      signedTenantId:
        'tenant-a' as F6AuditEntry<'cross_tenant_probe'>['tenantId'],
      sourceIp: '127.0.0.1',
      requestId: 'req-unit-test',
      attemptedRoute: '/api/admin/events/abc1234567890123',
    },
  };
}

function makeFailCtx() {
  return {
    tenantSlug: 'tenant-a',
    logEvent: 'f6_admin_cross_tenant_probe_audit_failed',
    logMsg:
      '[F6] admin cross_tenant_probe audit emit failed (suppressed — 404 still returned)',
  } as const;
}

describe('safeEmitStandalone — happy path', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('does not call logger.error when emitStandalone resolves with ok', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi
        .fn()
        .mockResolvedValue({ ok: true, value: 'audit-id-123' }),
    } as unknown as StandaloneAuditDeps;
    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());
    expect(errorSpy).not.toHaveBeenCalled();
    expect(deps.emitStandalone).toHaveBeenCalledTimes(1);
  });
});

describe('safeEmitStandalone — Result.err path (R8-I5 fix)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // R8-I5 regression guard — `emitStandalone` is typed
  // `Promise<Result<AuditEventId, AuditEmitError>>`; it returns
  // `{ ok: false, error: { kind, message? } }` on DB failure rather
  // than throwing. The pre-R8 helper's try/catch alone would have
  // silently swallowed this path. These tests pin the inspect-and-
  // log-on-Result.err behaviour.
  it('logs structured error when emitStandalone resolves with err', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'db_error', message: 'simulated PG error' },
      }),
    } as unknown as StandaloneAuditDeps;

    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logFields, logMessage] = errorSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logFields).toMatchObject({
      event: 'f6_admin_cross_tenant_probe_audit_failed',
      tenantSlug: 'tenant-a',
      auditErrorKind: 'db_error',
      auditErrorMessage: 'simulated PG error',
    });
    expect(logMessage).toBe(
      '[F6] admin cross_tenant_probe audit emit failed (suppressed — 404 still returned)',
    );
  });

  it('handles err variant without `message` field (auditErrorMessage=null)', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'enum_value_unknown', eventType: 'mystery_event' },
      }),
    } as unknown as StandaloneAuditDeps;
    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());
    const [logFields] = errorSpy.mock.calls[0] as [Record<string, unknown>];
    expect(logFields).toMatchObject({
      auditErrorKind: 'enum_value_unknown',
      auditErrorMessage: null,
    });
  });

  it('Result.err path also resolves (return-void invariant preserved)', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'db_error', message: 'x' },
      }),
    } as unknown as StandaloneAuditDeps;
    await expect(
      safeEmitStandalone(deps, makeEntry(), makeFailCtx()),
    ).resolves.toBeUndefined();
  });
});

describe('safeEmitStandalone — audit-failure path', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('catches Error rejection + logs structured fields with redacted stack', async () => {
    // Construct an Error whose stack contains a Vercel container
    // path — the redactStack scrubber must replace it before pino
    // sees the structured log. This is the round-6 W2 contract.
    const auditErr = new Error('audit DB connection refused');
    auditErr.stack =
      'Error: audit DB connection refused\n    at fn (/var/task/app/x.js:1:1)';
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockRejectedValue(auditErr),
    } as unknown as StandaloneAuditDeps;

    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logFields, logMessage] = errorSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logFields).toMatchObject({
      event: 'f6_admin_cross_tenant_probe_audit_failed',
      tenantSlug: 'tenant-a',
      errName: 'Error',
      errMessage: 'audit DB connection refused',
    });
    // Stack must be a string AND the container path must be
    // scrubbed (round-6 W2 + round-7 R2-C regression guard).
    expect(typeof logFields['errStack']).toBe('string');
    const errStack = logFields['errStack'] as string;
    expect(errStack).toContain('[redacted-path]');
    expect(errStack).not.toContain('/var/task/app/x.js');
    // logMsg pass-through.
    expect(logMessage).toBe(
      '[F6] admin cross_tenant_probe audit emit failed (suppressed — 404 still returned)',
    );
  });

  it('handles non-Error rejection (string) with errName=unknown + errStack=null', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockRejectedValue('string-error'),
    } as unknown as StandaloneAuditDeps;

    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logFields] = errorSpy.mock.calls[0] as [Record<string, unknown>];
    expect(logFields).toMatchObject({
      errName: 'unknown',
      errMessage: 'string-error',
      errStack: null,
    });
  });

  it('resolves (never throws) on audit failure — return-void invariant', async () => {
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as StandaloneAuditDeps;
    // If the helper re-threw, this would reject — assert it resolves.
    await expect(
      safeEmitStandalone(deps, makeEntry(), makeFailCtx()),
    ).resolves.toBeUndefined();
  });

  it('handles Error without a stack (errStack=null instead of redaction)', async () => {
    const err = new Error('no stack');
    delete (err as { stack?: string }).stack;
    const deps: StandaloneAuditDeps = {
      emitStandalone: vi.fn().mockRejectedValue(err),
    } as unknown as StandaloneAuditDeps;
    await safeEmitStandalone(deps, makeEntry(), makeFailCtx());
    const [logFields] = errorSpy.mock.calls[0] as [Record<string, unknown>];
    expect(logFields['errStack']).toBeNull();
  });
});
