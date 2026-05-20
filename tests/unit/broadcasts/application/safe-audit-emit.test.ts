/**
 * Unit tests for `safeAuditEmit` shared helper (F7.1a US2 Phase A).
 *
 * Closes PR-review Round-4 finding R4-M2: the helper is security-
 * critical (preserves rejection effect on audit-storage hiccup) but
 * its catch branch was never exercised by upstream contract tests
 * (all 3 callers mocked `audit.emit` as a successful no-op).
 *
 * Constitution Principle II — 100% branch coverage on security-
 * critical paths.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { safeAuditEmit } from '@/modules/broadcasts/application/use-cases/_safe-audit-emit';
import { logger } from '@/lib/logger';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';

const SAMPLE_EVENT: AuditEmitInput = {
  eventType: 'broadcast_image_unsafe',
  actorUserId: 'user-42',
  tenantId: 'tenant-test',
  summary: 'Test rejection',
  payload: { draftId: 'draft-1', verdict: 'error' },
  requestId: 'req-test-001',
};

describe('safeAuditEmit (Phase A R4-M2 closure)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('audit.emit resolves → no log, no throw', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    await expect(safeAuditEmit(audit, null, SAMPLE_EVENT)).resolves.toBeUndefined();
    expect(audit.emit).toHaveBeenCalledWith(null, SAMPLE_EVENT);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('audit.emit rejects → catches + logs structured error + returns void (preserves caller Result)', async () => {
    const failureCause = new Error('audit-storage transient failure');
    const audit: AuditPort = {
      emit: vi.fn().mockRejectedValue(failureCause),
    };

    // MUST NOT throw — the load-bearing behaviour is that the caller's
    // security rejection (the err() Result) is preserved + the audit
    // gap is captured in structured logs for SIEM forensics.
    await expect(safeAuditEmit(audit, null, SAMPLE_EVENT)).resolves.toBeUndefined();
    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Verify structured log shape — SIEM alerts key off
    // 'broadcasts.audit.emit_failed' so the message string is
    // load-bearing for the runbook (docs/runbooks/audit-emit-loss.md).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'audit-storage transient failure',
        eventType: 'broadcast_image_unsafe',
        tenantId: 'tenant-test',
        actorUserId: 'user-42',
        requestId: 'req-test-001',
      }),
      'broadcasts.audit.emit_failed',
    );
  });

  it('audit.emit rejects with non-Error value → still catches + logs stringified err', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockRejectedValue('plain string failure'),
    };
    await expect(safeAuditEmit(audit, null, SAMPLE_EVENT)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'plain string failure' }),
      'broadcasts.audit.emit_failed',
    );
  });

  it('threads tx argument unchanged (atomic-tx path used by manageImageAllowlist)', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    const fakeTx = { __test: 'tx-handle' };
    await safeAuditEmit(audit, fakeTx, SAMPLE_EVENT);
    expect(audit.emit).toHaveBeenCalledWith(fakeTx, SAMPLE_EVENT);
  });
});
