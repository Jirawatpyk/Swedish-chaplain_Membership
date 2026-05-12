/**
 * Unit tests for `pino-audit-port` covering the in-tx `emit` and
 * separate-tx `emitRolledBack` paths' `logFullError` invocations.
 *
 * Integration test `emit-standalone.test.ts` exercises the
 * `emitStandalone` caller's `logFullError` via a real slug-guard
 * throw + live Neon Singapore connection. These unit tests close the
 * remaining 2 callers (`emit` + `emitRolledBack`) without requiring
 * DB unavailability — mock the executor / `db.transaction` so the
 * try/catch surfaces the `logFullError` shape.
 *
 * What's verified:
 *   - `emit` catch invokes logger.error with
 *     `event:'f6_audit_emit_db_error', caller:'emit'` + structured err
 *   - `emitRolledBack` catch invokes logger.error with
 *     `caller:'emitRolledBack'` + structured err
 *   - Sanitised result message reaches Result.err for both paths
 *   - `audit_secondary_tx_failure: true` marker on `emitRolledBack`
 *     pino.fatal fallback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import type { TenantTx } from '@/lib/db';
import type { F6AuditEntry } from '@/modules/events/application/ports/audit-port';

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    db: {
      transaction: vi.fn(),
    },
  };
});

const VALID_ENTRY: F6AuditEntry<'webhook_rolled_back'> = {
  eventType: 'webhook_rolled_back',
  tenantId: 'test-chamber' as F6AuditEntry<'webhook_rolled_back'>['tenantId'],
  actorType: 'zapier_webhook',
  actorUserId: null,
  occurredAt: new Date(),
  summary: 'unit test rolled-back entry',
  payload: {
    severity: 'error',
    requestId: 'req-unit-test',
    source: 'eventcreate',
    failureStage: 'unknown',
    errorMessage: 'unit-test forced failure',
    errorStack: null,
  },
};

describe('pino-audit-port — logFullError coverage on emit + emitRolledBack', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fatalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fatalSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('emit (in-tx) — executor.execute throw → logFullError with caller="emit" + sanitised Result.err', async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(
        new Error('relation "audit_log" does not exist'),
      ),
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emit(VALID_ENTRY);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    // Sanitiser strips `"audit_log"` identifier
    expect(result.error.message).toMatch(/relation\s+"\[redacted\]"/);

    // logFullError preserves the unsanitised name + message + stack
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emit',
        tenantId: 'test-chamber',
        eventType: 'webhook_rolled_back',
        err: expect.objectContaining({
          name: expect.any(String),
          message: expect.stringContaining('audit_log'),
          stack: expect.any(String),
        }),
      }),
      expect.any(String),
    );
  });

  it('emitRolledBack — db.transaction throw → logFullError with caller="emitRolledBack" + audit_secondary_tx_failure marker', async () => {
    const { db } = await import('@/lib/db');
    vi.mocked(db.transaction).mockRejectedValue(
      new Error('column "tenant_id" of constraint "audit_log_pkey" violation'),
    );

    // Dummy executor — emitRolledBack uses root db.transaction not this
    const executor = {
      execute: () => {
        throw new Error('not reached');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emitRolledBack(VALID_ENTRY);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    expect(result.error.message).toMatch(/column\s+"\[redacted\]"/);

    // logFullError preserves the unsanitised name + message + stack
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emitRolledBack',
        tenantId: 'test-chamber',
        eventType: 'webhook_rolled_back',
        err: expect.objectContaining({
          name: expect.any(String),
          message: expect.stringContaining('tenant_id'),
          stack: expect.any(String),
        }),
      }),
      expect.any(String),
    );

    // pino.fatal secondary-tx-failure marker fires per FR-037 dual-write fallback
    expect(fatalSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook_rolled_back',
        audit_secondary_tx_failure: true,
        tenantId: 'test-chamber',
      }),
      expect.stringContaining('audit secondary-tx failure'),
    );
  });

  it('emitRolledBack — invalid tenantId fails slug-guard regex → logFullError with caller="emitRolledBack"', async () => {
    const executor = {
      execute: () => {
        throw new Error('not reached');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emitRolledBack({
      ...VALID_ENTRY,
      tenantId: "evil'; DROP TABLE audit_log; --" as unknown as F6AuditEntry<'webhook_rolled_back'>['tenantId'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    expect(result.error.message).toMatch(/slug invariant violated/);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emitRolledBack',
        err: expect.objectContaining({
          message: expect.stringContaining('slug invariant violated'),
        }),
      }),
      expect.any(String),
    );
  });
});
