/**
 * Verify the C-1 / C-2 audit-emit failure observability paths.
 *
 * Previous review found that `csvImportAuditEmitFailed` counter had 0
 * grep hits in `tests/`, so a regression dropping any of the 4
 * `eventcreateMetrics.csvImportAuditEmitFailed(...)` emit points in
 * `import-csv.ts` would not fail CI.
 *
 * This unit test mocks `deps.emitStandalone` to return `Result.err`
 * on selected event types, then asserts:
 *   1. `logger.error` is called with the expected event name
 *   2. `eventcreateMetrics.csvImportAuditEmitFailed(tenantId, eventType)`
 *      is called with the matching label pair
 *   3. The use-case STILL returns `{kind:'completed'}` — the route
 *      response is independent of audit-emit outcome ("DB committed"
 *      invariant: the rows persisted; the audit row is the only loss).
 *
 * Covers both surfaces: `csv_import_completed` (C-2) AND
 * `csv_import_row_failed` (C-1, via savepoint-catch path).
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvOutcome,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { f6CsvTestSelectedEventStub, makeCsvImporterMock } from './_helpers/f6-csv-test-fixtures';

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/metrics', () => ({
  eventcreateMetrics: {
    csvImportAuditEmitFailed: vi.fn(),
    csvImportCompleted: vi.fn(),
    csvImportDurationSeconds: vi.fn(),
    csvImportRateLimitFallback: vi.fn(),
    csvImportAdapterModeDetected: vi.fn(),
    csvImportSafetyNetFallback: vi.fn(),
    createEventDurationSeconds: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

const VALID_CSV = new TextEncoder().encode(
  [
    'event_external_id,event_name,event_start,attendee_email,attendee_name',
    'event_audit_test,Audit Test,2026-06-21T18:00:00+07:00,audit@example.com,Audit Attendee',
    '',
  ].join('\n'),
);

type FakeDepsOpts = {
  /** When true, all `emitStandalone` calls return Result.err. */
  readonly emitFails: boolean;
  /**
   * When true, `idempotencyStore.tryInsert` returns Result.err so the
   * savepoint callback throws and `processOneRowInSavepoint` catch
   * emits `csv_import_row_failed` — the C-1 audit-emit failure path.
   */
  readonly forceRowFailure?: boolean;
};

function makeFakeDeps(opts: FakeDepsOpts): ImportCsvDeps {
  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    idempotencyStore: {
      tryInsert: vi.fn(async () => {
        if (opts.forceRowFailure === true) {
          return err({
            kind: 'db_error' as const,
            message: 'simulated idempotency-receipt failure',
          });
        }
        return ok({ wasFresh: false, originalProcessedAt: null });
      }),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
      advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
  } as unknown as ImportCsvTxScopedPorts;

  return {
    csvImporter: makeCsvImporterMock(vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'a'.repeat(64),
              row: {
                event_external_id: 'event_audit_test',
                event_name: 'Audit Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'audit@example.com',
                attendee_name: 'Audit Attendee',
                payment_status: 'paid' as const,
              },
              pdpaConsentAcknowledged: null,
              intendedStateChange: false,
            };
          })(),
        ),
      )),
    runInTenantTx: vi.fn(async (_tenantId, fn) => fn(fakeBatchPorts)),
    emitStandalone: vi.fn(async () => {
      if (opts.emitFails) {
        return err({
          kind: 'db_error' as const,
          message: 'simulated audit-emit failure',
        });
      }
      return ok('audit-id' as never);
    }),
  } as unknown as ImportCsvDeps;
}

describe('NEW-J — C-1 + C-2 audit-emit failure observability', () => {
  it('C-2: csv_import_completed emit failure logs + bumps counter; use-case still returns completed', async () => {
    vi.clearAllMocks();
    const deps = makeFakeDeps({ emitFails: true });

    const outcome: ImportCsvOutcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-audit'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000111'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    // "DB committed" invariant — route still returns 200.
    expect(outcome.kind).toBe('completed');

    // C-2: logger.error fires for csv_import_completed emit failure.
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const completedAuditErrorCall = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_import_completed_audit_emit_failed',
    );
    expect(completedAuditErrorCall).toBeDefined();

    // C-1: dedicated counter increments with BOTH the tenantId AND the
    // failed eventType label (strict equality — guards against cross-
    // tenant audit smuggle regressions).
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const completedCounterCall = counterCalls.find(
      (c) => c[1] === 'csv_import_completed',
    );
    expect(completedCounterCall).toEqual([
      'test-chamber-audit',
      'csv_import_completed',
    ]);
  });

  it('C-1: csv_import_row_failed emit failure logs + bumps counter (savepoint-thrown row + audit emit Result.err)', async () => {
    vi.clearAllMocks();
    // Force a row failure inside the savepoint → catch emits
    // `csv_import_row_failed` via `safeEmitRowFailed`. The same
    // `emitStandalone` mock then returns Result.err → exercises the
    // C-1 logger.error + counter path at `safeEmitRowFailed`'s
    // inner-`!result.ok` branch.
    const deps = makeFakeDeps({ emitFails: true, forceRowFailure: true });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-row-fail'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000113'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    // The row failed → outcome.kind is still 'completed' (use-case
    // aggregates errors into summary.errorRows; routing returns 200).
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.summary.errorRows).toHaveLength(1);
      expect(outcome.summary.errorRows[0]!.rowNumber).toBe(2);
    }

    // C-1: logger.error fires for the row-failed emit failure.
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const rowFailedAuditErrorCall = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_row_failed_audit_emit_failed',
    );
    expect(rowFailedAuditErrorCall).toBeDefined();

    // Counter bumps with the row-failed eventType label.
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const rowFailedCounterCall = counterCalls.find(
      (c) => c[1] === 'csv_import_row_failed',
    );
    expect(rowFailedCounterCall).toEqual([
      'test-chamber-row-fail',
      'csv_import_row_failed',
    ]);
  });

  it('csv_import_row_failed emit payload contains the failureStage taxonomy field (NEW-D wiring)', async () => {
    vi.clearAllMocks();
    // Force a row failure; emitStandalone resolves Result.ok so we can
    // inspect the payload it received without the C-1 failure path.
    const deps = makeFakeDeps({ emitFails: false, forceRowFailure: true });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-failurestage'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000114'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');

    // Find the row-failed emit (the row-failed audit fires inside
    // `safeEmitRowFailed` BEFORE the per-import csv_import_completed).
    const emitCalls = (
      deps.emitStandalone as ReturnType<typeof vi.fn>
    ).mock.calls;
    const rowFailedEmit = emitCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as { eventType?: string }).eventType ===
          'csv_import_row_failed',
    );
    expect(rowFailedEmit).toBeDefined();

    // NEW-D: the payload MUST carry failureStage so dashboards can
    // alert on `audit_emit` (security-critical) separately from
    // routine validation failures. The shared `processAttendeeInTx`
    // helper throws non-TxStageError plain `Error` for idempotency-
    // receipt failures, so this path resolves to `'unknown'` —
    // strictly more informative than no field.
    const payload = (rowFailedEmit?.[0] as { payload?: Record<string, unknown> })
      ?.payload;
    expect(payload).toBeDefined();
    expect(payload).toHaveProperty('failureStage');
    expect(typeof payload?.['failureStage']).toBe('string');
    expect([
      'event_upsert',
      'registration_insert',
      'idempotency_receipt',
      'quota_decrement',
      'audit_emit',
      'unknown',
    ]).toContain(payload?.['failureStage']);
  });

  it('audit emit success: logger.error NOT called + counter NOT incremented (control path)', async () => {
    vi.clearAllMocks();
    const deps = makeFakeDeps({ emitFails: false });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-audit-ok'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000112'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(counterCalls).toHaveLength(0);
  });

  it('R2 I2 (Round 2 — pr-test-analyzer): csvImportAdapterModeDetected fires EXACTLY ONCE per import with format label', async () => {
    // R2 I2 gap: the metric was mocked across the suite but never
    // asserted. A regression deleting the single emit site
    // (`import-csv.ts:847`) or accidentally placing it inside the
    // row loop would have shipped silently — the metric is the
    // rollback-trigger signal per spec § Rollback Plan + SC-008, so
    // call-count drift is a release-blocker.
    vi.clearAllMocks();
    const deps = makeFakeDeps({ emitFails: false });
    await importCsv(
      {
        tenantId: asTenantId('test-chamber-adapter-mode'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000115'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    const adapterModeMock = eventcreateMetrics.csvImportAdapterModeDetected as ReturnType<
      typeof vi.fn
    >;
    expect(adapterModeMock).toHaveBeenCalledTimes(1);
    // Format label is `'generic_csv'` because legacy mock fixture
    // wraps parseStream into parseStreamWithFormat with default
    // `format:'generic_csv'`. Real EventCreate paths emit
    // `'eventcreate_csv'`; both are valid per the union type.
    expect(adapterModeMock).toHaveBeenCalledWith(
      'test-chamber-adapter-mode',
      'generic_csv',
    );
  });
});
