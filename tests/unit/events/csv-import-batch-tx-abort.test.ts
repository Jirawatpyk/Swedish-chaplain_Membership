/**
 * Regression coverage for the ghost-row reporting invariant:
 *   - When the outer `runInTenantTx` callback resolves successfully
 *     (every row's savepoint committed and the tentative buffer is
 *     fully populated), but then the OUTER `await runInTenantTx(...)`
 *     itself throws (deferred-constraint COMMIT failure, network drop
 *     mid-COMMIT, serialisation conflict), Postgres rolls back ALL
 *     row effects. The use-case MUST NOT report those rows as
 *     `inserted` in the summary; ALL of them must be `row_failed`.
 *
 * Without this test, a regression re-introducing the pre-NEW-A pattern
 * (assigning per-row outcomes directly to `outcomes[index]` inside the
 * tx callback) would ship silently. Re-introducing the H-1
 * `outcomes[index] === undefined` guard in the catch fan-out would
 * ALSO ship silently — the catch must unconditionally mark every
 * non-savepoint-thrown row as row_failed.
 *
 * Also covers the duplicate-audit-emit guard from H-R3-01: rows whose
 * savepoint already emitted `csv_import_row_failed` (via
 * `processOneRowInSavepoint`'s catch) must NOT get a second fan-out
 * emit when the outer COMMIT then fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
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
    csvErrorCsvUploadFailed: vi.fn(),
    csvErrorCsvSweepClearFailed: vi.fn(),
    csvSweepScanFailed: vi.fn(),
    csvImportParserThrew: vi.fn(),
    csvImportStateChangeFallback: vi.fn(),
    csvErrorCsvDownloaded: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

function buildCsv(rows: number): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,attendee_email,attendee_name';
  const lines: string[] = [header];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `event_commit_${i},Commit Failure Test,2026-06-21T18:00:00+07:00,commit_${i}@example.com,Attendee ${i}`,
    );
  }
  return new TextEncoder().encode(lines.join('\n'));
}

describe('NEW-A regression — ghost-row invariant on COMMIT-time failure', () => {
  it('rejects ALL inserted-tentative outcomes as row_failed when outer tx throws AFTER callback resolved', async () => {
    const fakeBatchPorts: ImportCsvTxScopedPorts = {
      runRowInSavepoint: (async <T>(
        fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
      ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
      idempotencyStore: {
        // wasFresh: false → every row short-circuits to 'duplicate' BEFORE
        // calling processAttendeeInTx. The tentative buffer fills with
        // 'duplicate' outcomes; under pre-NEW-A code those would have
        // been promoted to summary.rowsAlreadyImported. Under correct
        // post-NEW-A code, the outer-throw catch overwrites them all
        // with row_failed.
        tryInsert: vi.fn(async () =>
          ok({ wasFresh: false, originalProcessedAt: null }),
        ),
      } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
        advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
  } as unknown as ImportCsvTxScopedPorts;

    const deps = {
      csvImporter: makeCsvImporterMock(vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
          const text = new TextDecoder().decode(bytes);
          const lines = text.split('\n').filter((l) => l.length > 0);
          const dataLines = lines.slice(1);
          return ok(
            (async function* () {
              for (let i = 0; i < dataLines.length; i++) {
                const cols = dataLines[i]!.split(',');
                yield {
                  ok: true as const,
                  rowNumber: i + 2,
                  rowHash: i.toString(16).padStart(64, '0'),
                  row: {
                    event_external_id: cols[0]!,
                    event_name: cols[1]!,
                    event_start: cols[2]!,
                    attendee_email: cols[3]!,
                    attendee_name: cols[4]!,
                    payment_status: 'paid' as const,
                  },
                  pdpaConsentAcknowledged: null,
                  intendedStateChange: false,
                };
              }
            })(),
          );
        })),
      // Simulate the failure mode: the inner callback resolves
      // successfully (fills tentativeOutcomes); then the OUTER
      // `runInTenantTx` itself throws — modelling deferred-constraint
      // COMMIT failure / network drop mid-COMMIT / serialisation
      // conflict raised by Postgres at COMMIT time.
      runInTenantTx: vi.fn(
        async (
          _tenantId: string,
          fn: (ports: ImportCsvTxScopedPorts) => Promise<unknown>,
        ) => {
          await fn(fakeBatchPorts);
          throw new Error(
            'simulated deferred-constraint COMMIT failure (40001 serialization_failure)',
          );
        },
      ),
      emitStandalone: vi.fn(async () => ok('audit-id' as never)),
    } as unknown as ImportCsvDeps;

    const ROW_COUNT = 3;
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-commit-abort'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000201'),
        bytes: buildCsv(ROW_COUNT),
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      // Ghost-row invariant: NO row reported as inserted or duplicate.
      // ALL rows must be in errorRows[] with the batch-tx-abort reason.
      expect(outcome.summary.rowsProcessed).toBe(0);
      expect(outcome.summary.rowsAlreadyImported).toBe(0);
      expect(outcome.summary.errorRows).toHaveLength(ROW_COUNT);
      for (const errorRow of outcome.summary.errorRows) {
        expect(errorRow.reason).toContain('batch tx aborted:');
        expect(errorRow.reason).toContain('deferred-constraint');
      }
    }

    // Audit emit fan-out: one per dbRow (none of these rows reached
    // the savepoint-catch path; tentative outcomes were 'duplicate').
    const emitCalls = (deps.emitStandalone as ReturnType<typeof vi.fn>).mock
      .calls;
    const rowFailedEmits = emitCalls.filter(
      (c) =>
        (c[0] as { eventType?: string }).eventType ===
        'csv_import_row_failed',
    );
    expect(rowFailedEmits).toHaveLength(ROW_COUNT);
  });

  it('H-R3-01 duplicate-audit guard: rows that savepoint-thrown emit only ONE csv_import_row_failed audit on combined savepoint+commit failure', async () => {
    // Force savepoint to throw → processOneRowInSavepoint catch emits
    // 1× csv_import_row_failed per row. Then outer tx ALSO throws →
    // fan-out at the catch block. Without the dedup guard the fan-out
    // would emit a 2nd audit per row. With the guard, total emit
    // count is exactly ROW_COUNT (one per row, savepoint-side only).
    const fakeBatchPorts: ImportCsvTxScopedPorts = {
      runRowInSavepoint: (async <T>(
        _fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
      ) => {
        // Throwing here lands in processOneRowInSavepoint's catch
        // → safeEmitRowFailed fires 1× csv_import_row_failed.
        throw new Error('simulated savepoint failure');
      }) as ImportCsvTxScopedPorts['runRowInSavepoint'],
      idempotencyStore: {
        tryInsert: vi.fn(async () =>
          ok({ wasFresh: true, originalProcessedAt: null }),
        ),
      } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
        advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
  } as unknown as ImportCsvTxScopedPorts;

    const deps = {
      csvImporter: makeCsvImporterMock(vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
          const text = new TextDecoder().decode(bytes);
          const lines = text.split('\n').filter((l) => l.length > 0);
          const dataLines = lines.slice(1);
          return ok(
            (async function* () {
              for (let i = 0; i < dataLines.length; i++) {
                const cols = dataLines[i]!.split(',');
                yield {
                  ok: true as const,
                  rowNumber: i + 2,
                  rowHash: (i + 1000).toString(16).padStart(64, '0'),
                  row: {
                    event_external_id: cols[0]!,
                    event_name: cols[1]!,
                    event_start: cols[2]!,
                    attendee_email: cols[3]!,
                    attendee_name: cols[4]!,
                    payment_status: 'paid' as const,
                  },
                  pdpaConsentAcknowledged: null,
                  intendedStateChange: false,
                };
              }
            })(),
          );
        })),
      runInTenantTx: vi.fn(
        async (
          _tenantId: string,
          fn: (ports: ImportCsvTxScopedPorts) => Promise<unknown>,
        ) => {
          await fn(fakeBatchPorts);
          // Outer tx throws AFTER all rows ran their savepoint-throw
          // path → catch fan-out would emit duplicate audits without
          // the dedup guard.
          throw new Error('simulated outer-tx abort');
        },
      ),
      emitStandalone: vi.fn(async () => ok('audit-id' as never)),
    } as unknown as ImportCsvDeps;

    const ROW_COUNT = 3;
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-dedup-guard'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000202'),
        bytes: buildCsv(ROW_COUNT),
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');

    const emitCalls = (deps.emitStandalone as ReturnType<typeof vi.fn>).mock
      .calls;
    const rowFailedEmits = emitCalls.filter(
      (c) =>
        (c[0] as { eventType?: string }).eventType ===
        'csv_import_row_failed',
    );
    // Strict: exactly ROW_COUNT emits (one per row from savepoint
    // catch). Regression to pre-fix would yield 2×ROW_COUNT.
    expect(rowFailedEmits).toHaveLength(ROW_COUNT);
  });

  it('R2-I-7 (R3): outer-tx commit failure → batch-tx-aborted log + fan-out emit loop reached + f6_csv_batch_fan_out_rejected fires when safeEmitRowFailed rejects', async () => {
    // The R2-I-7 fix adds defensive logging on `Promise.allSettled`
    // rejections in the fan-out emit loop. `safeEmitRowFailed` has its
    // own internal try/catch so it normally cannot reject — but if a
    // dependency injected into `recordAuditEmitFailure` (the
    // `eventcreateMetrics.csvImportAuditEmitFailed` counter) throws
    // synchronously, the throw escapes safeEmitRowFailed's catch
    // because the catch CALLS recordAuditEmitFailure too. This forces
    // the fan-out-rejection branch which the R2-I-7 log captures.
    const { logger } = await import('@/lib/logger');
    const { eventcreateMetrics } = await import('@/lib/metrics');
    (logger.error as ReturnType<typeof vi.fn>).mockClear();

    // Force csvImportAuditEmitFailed to throw — propagates out of
    // safeEmitRowFailed's catch since the catch also calls the same
    // metric counter.
    (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => {
      throw new Error('simulated metric counter throw');
    });
    (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => {
      throw new Error('simulated metric counter throw (catch re-emit)');
    });

    // Mock `runRowInSavepoint` to return a successful `inserted` row
    // outcome directly (bypassing the real processAttendeeInTx chain).
    // The fan-out filter at the outer-tx catch path only INCLUDES rows
    // whose savepoint succeeded (`kind !== 'row_failed'`). Then the
    // outer-tx throws → fan-out runs safeEmitRowFailed for each row →
    // forced metric-counter throw propagates out → Promise rejects →
    // R2-I-7 log fires.
    let runRowCallIndex = 0;
    const fakeBatchPorts: ImportCsvTxScopedPorts = {
      runRowInSavepoint: vi.fn(async (_fn) => {
        const rowNumber = (runRowCallIndex += 1) + 1; // rows 2, 3
        return {
          kind: 'inserted' as const,
          rowNumber,
          matchType: 'unmatched' as const,
          eventCreated: false,
        };
      }) as unknown as ImportCsvTxScopedPorts['runRowInSavepoint'],
      idempotencyStore: {
        tryInsert: vi.fn(async () =>
          ok({ wasFresh: true, originalProcessedAt: null }),
        ),
      } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
      advisoryLockAcquirer: {
        acquire: vi.fn(async () => {}),
      } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
    } as unknown as ImportCsvTxScopedPorts;

    const deps = {
      csvImporter: makeCsvImporterMock(
        vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
          const text = new TextDecoder().decode(bytes);
          const lines = text.split('\n').filter((l) => l.length > 0);
          const dataLines = lines.slice(1);
          return ok(
            (async function* () {
              for (let i = 0; i < dataLines.length; i++) {
                const cols = dataLines[i]!.split(',');
                yield {
                  ok: true as const,
                  rowNumber: i + 2,
                  rowHash: (i + 2000).toString(16).padStart(64, '0'),
                  row: {
                    event_external_id: cols[0]!,
                    event_name: cols[1]!,
                    event_start: cols[2]!,
                    attendee_email: cols[3]!,
                    attendee_name: cols[4]!,
                    payment_status: 'paid' as const,
                  },
                  pdpaConsentAcknowledged: null,
                  intendedStateChange: false,
                };
              }
            })(),
          );
        }),
      ),
      runInTenantTx: vi.fn(
        async (
          _tenantId: string,
          fn: (ports: ImportCsvTxScopedPorts) => Promise<unknown>,
        ) => {
          await fn(fakeBatchPorts);
          throw new Error('simulated outer-tx commit failure');
        },
      ),
      // emitStandalone returns Result.err so the fan-out path triggers
      // recordAuditEmitFailure (which throws via the metric mock).
      emitStandalone: vi.fn(async () =>
        err({ kind: 'db_error' as const, message: 'forced emit fail' }),
      ),
    } as unknown as ImportCsvDeps;

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-fanout-rejected'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000777'),
        bytes: buildCsv(2),
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    expect(outcome.kind).toBe('completed');

    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    // The outer-tx-aborted log fires from the catch entry.
    const batchAbortLog = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_batch_tx_aborted',
    );
    expect(batchAbortLog).toBeDefined();
    // CRITICAL R3-I-2: the fan-out-rejected log fires when
    // safeEmitRowFailed rejects (which requires its internal
    // recordAuditEmitFailure to throw — exercised via the metric
    // mock above).
    const fanOutRejectedLog = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_batch_fan_out_rejected',
    );
    expect(fanOutRejectedLog).toBeDefined();
  });
});
