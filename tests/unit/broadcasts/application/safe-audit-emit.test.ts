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
import {
  safeAuditEmit,
  safeAuditEmitTyped,
} from '@/modules/broadcasts/application/use-cases/_safe-audit-emit';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type {
  AuditEmitInput,
  AuditPort,
  TypedAuditEmitInput,
  F7AuditPayloadShapes,
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
  let metricSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    // H3 Round 2 fix 2026-05-21 (review finding pr-test-analyzer C1):
    // pin the `broadcastsMetrics.auditEmitFailed` counter increment.
    // The metric is the SLO-alarm source per docs/observability.md § 22.2;
    // a future refactor dropping the counter inside safeAuditEmit would
    // silently kill the SIEM alert pipeline. This spy turns that into a
    // hard test failure.
    metricSpy = vi
      .spyOn(broadcastsMetrics, 'auditEmitFailed')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    metricSpy.mockRestore();
  });

  it('audit.emit resolves → no log, no metric, no throw', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    await expect(safeAuditEmit(audit, null, SAMPLE_EVENT)).resolves.toBeUndefined();
    expect(audit.emit).toHaveBeenCalledWith(null, SAMPLE_EVENT);
    expect(errorSpy).not.toHaveBeenCalled();
    // H3 counter assertion: success path MUST NOT increment the counter.
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('audit.emit rejects → catches + logs structured error + returns void (preserves caller Result)', async () => {
    const failureCause = new Error('audit-storage transient failure');
    const audit: AuditPort = {
      emit: vi.fn().mockRejectedValue(failureCause),
      emitTyped: vi.fn().mockRejectedValue(failureCause),
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

    // H3 counter assertion: failure path MUST increment the counter
    // with the event type + tenant id, so the alert pipeline at
    // docs/observability.md § 22.2 fires on any non-zero rate.
    expect(metricSpy).toHaveBeenCalledTimes(1);
    expect(metricSpy).toHaveBeenCalledWith('broadcast_image_unsafe', 'tenant-test');
  });

  it('audit.emit rejects with non-Error value → still catches + logs stringified err', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockRejectedValue('plain string failure'),
      emitTyped: vi.fn().mockRejectedValue('plain string failure'),
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
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    const fakeTx = { __test: 'tx-handle' };
    await safeAuditEmit(audit, fakeTx, SAMPLE_EVENT);
    expect(audit.emit).toHaveBeenCalledWith(fakeTx, SAMPLE_EVENT);
  });

  it('R8.5 LOW-1: re-throws adapter invariant errors (f7AuditAdapter: prefix)', async () => {
    // Programmer-bug invariants raised by `f7AuditAdapter` (e.g.,
    // "mutation tx requires non-null tenantId") MUST surface as test
    // failures / 5xx, NOT be silently swallowed by the fail-soft
    // envelope. Identification: message prefix `f7AuditAdapter:`.
    const audit: AuditPort = {
      emit: vi.fn().mockRejectedValue(
        new Error(
          'f7AuditAdapter: mutation tx requires non-null tenantId ' +
            '(eventType=broadcast_template_snapshotted). Use tx=null for system audits.',
        ),
      ),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    await expect(safeAuditEmit(audit, null, SAMPLE_EVENT)).rejects.toThrow(
      /f7AuditAdapter:/,
    );
    // Logger should NOT have fired — the invariant re-throws before
    // the error path runs.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('R8.5 LOW-1: non-invariant Errors still get swallowed + logged', async () => {
    // Sanity: the fail-soft envelope still works for transient
    // hiccups whose message does NOT start with `f7AuditAdapter:`.
    const audit: AuditPort = {
      emit: vi
        .fn()
        .mockRejectedValue(new Error('connection terminated unexpectedly')),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      safeAuditEmit(audit, null, SAMPLE_EVENT),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'connection terminated unexpectedly',
      }),
      'broadcasts.audit.emit_failed',
    );
  });
});

// =============================================================================
// R008 Round 2 closure 2026-05-21 (senior-tester staff-review condition):
// `safeAuditEmitTyped` sibling function had ZERO direct unit tests prior to
// this block. Indirect coverage via `snapshot-template-to-draft.test.ts:228`
// pinned the use-case outcome but NOT the metric counter increment at
// `_safe-audit-emit.ts:146`. A regression removing that counter call would
// have silently killed the SIEM alert pipeline for the
// `broadcast_template_snapshot_refused_deleted` event type. This block pins
// the counter behaviour explicitly. Mirrors the safeAuditEmit suite above.
// =============================================================================

const SAMPLE_TYPED_EVENT: TypedAuditEmitInput<
  'broadcast_template_snapshot_refused_deleted'
> = {
  eventType: 'broadcast_template_snapshot_refused_deleted',
  actorUserId: 'user-typed-42',
  tenantId: 'tenant-typed-test',
  summary: 'Template was soft-deleted between picker render and snapshot',
  payload: {
    broadcastId: 'broadcast-typed-1',
    templateId: 'template-typed-1',
    templateNameSnapshot: 'Monthly Newsletter',
    memberId: 'member-typed-1',
  } satisfies F7AuditPayloadShapes['broadcast_template_snapshot_refused_deleted'],
  requestId: 'req-typed-test-001',
};

describe('safeAuditEmitTyped (R008 Round 2 closure — typed sibling coverage)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let metricSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    metricSpy = vi
      .spyOn(broadcastsMetrics, 'auditEmitFailed')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    metricSpy.mockRestore();
  });

  it('audit.emitTyped resolves → no log, no metric, no throw', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      safeAuditEmitTyped(audit, null, SAMPLE_TYPED_EVENT),
    ).resolves.toBeUndefined();
    expect(audit.emitTyped).toHaveBeenCalledWith(null, SAMPLE_TYPED_EVENT);
    expect(audit.emit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('audit.emitTyped rejects → catches + logs + increments counter + returns void', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi
        .fn()
        .mockRejectedValue(new Error('typed audit storage transient failure')),
    };

    await expect(
      safeAuditEmitTyped(audit, null, SAMPLE_TYPED_EVENT),
    ).resolves.toBeUndefined();
    expect(audit.emitTyped).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'typed audit storage transient failure',
        eventType: 'broadcast_template_snapshot_refused_deleted',
        tenantId: 'tenant-typed-test',
        actorUserId: 'user-typed-42',
        requestId: 'req-typed-test-001',
      }),
      'broadcasts.audit.emit_failed',
    );

    // R008 critical assertion: counter MUST be incremented with the
    // (eventType, tenantId) tuple so the SIEM alert at § 22.2 fires.
    expect(metricSpy).toHaveBeenCalledTimes(1);
    expect(metricSpy).toHaveBeenCalledWith(
      'broadcast_template_snapshot_refused_deleted',
      'tenant-typed-test',
    );
  });

  it('threads tx argument unchanged (atomic-tx path)', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi.fn().mockResolvedValue(undefined),
    };
    const fakeTx = { __test: 'tx-typed-handle' };
    await safeAuditEmitTyped(audit, fakeTx, SAMPLE_TYPED_EVENT);
    expect(audit.emitTyped).toHaveBeenCalledWith(fakeTx, SAMPLE_TYPED_EVENT);
  });

  it('R8.5 LOW-1: re-throws adapter invariant errors (f7AuditAdapter: prefix)', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi.fn().mockRejectedValue(
        new Error(
          'f7AuditAdapter: mutation tx requires non-null tenantId ' +
            '(eventType=broadcast_template_snapshotted). Use tx=null for system audits.',
        ),
      ),
    };
    await expect(
      safeAuditEmitTyped(audit, null, SAMPLE_TYPED_EVENT),
    ).rejects.toThrow(/f7AuditAdapter:/);
    // Invariant re-throws BEFORE error path runs — logger/counter not called.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('R8.5 LOW-1: non-invariant Errors still get swallowed + logged + metered', async () => {
    const audit: AuditPort = {
      emit: vi.fn().mockResolvedValue(undefined),
      emitTyped: vi
        .fn()
        .mockRejectedValue(new Error('connection terminated unexpectedly')),
    };
    await expect(
      safeAuditEmitTyped(audit, null, SAMPLE_TYPED_EVENT),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection terminated unexpectedly' }),
      'broadcasts.audit.emit_failed',
    );
    expect(metricSpy).toHaveBeenCalledWith(
      'broadcast_template_snapshot_refused_deleted',
      'tenant-typed-test',
    );
  });
});
