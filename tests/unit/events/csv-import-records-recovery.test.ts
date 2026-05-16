/**
 * R2 (Round 2 — pr-test-analyzer C4) — CR-5 csv_import_records
 * recovery INSERT path coverage.
 *
 * CR-5 (Round 1 — silent-failure-hunter) added a recovery branch:
 * when `updateOutcome` returns `err({kind:'not_found'})` (placeholder
 * INSERT never landed → zero-rows-affected UPDATE), the use-case
 * opens a fresh `withImportRecordsTx` and tries a single INSERT with
 * the final outcome. Until R2, this branch had ZERO test coverage —
 * a regression deleting the recovery path or the `.returning()`
 * shape would have shipped silently.
 *
 * This test mocks `deps.withImportRecordsTx` to control the placeholder
 * UPDATE + recovery INSERT outcomes independently:
 *   1. First tx call: updateOutcome → err({kind:'not_found'})
 *      → triggers the recovery path
 *   2. Second tx call: repo.insert → ok(undefined),
 *      repo.updateOutcome → ok(undefined)
 *      → recovery succeeds, historyPersisted=true
 *
 * Negative variant: second tx also fails → logger.error fires +
 * historyPersisted=false propagated to the outcome.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import type { CsvImportRecordsRepository } from '@/modules/events/application/ports/csv-import-records-repo';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { logger } from '@/lib/logger';
import {
  f6CsvTestSelectedEventStub,
  makeCsvImporterMock,
} from './_helpers/f6-csv-test-fixtures';

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
    createEventRateLimitFallback: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

const VALID_CSV = new TextEncoder().encode(
  [
    'event_external_id,event_name,event_start,attendee_email,attendee_name',
    'event_recovery_test,Recovery Test,2026-06-21T18:00:00+07:00,recovery@example.com,Recovery Attendee',
    '',
  ].join('\n'),
);

interface RecoveryScenario {
  /**
   * First tx invocation outcome (for the placeholder UPDATE):
   *   - 'not_found' → triggers the recovery branch
   *   - 'ok'        → happy path (no recovery; flag stays true)
   *   - 'db_error'  → non-recovery error (flag flips false, no recovery
   *                   path)
   */
  readonly firstTxOutcome: 'not_found' | 'ok' | 'db_error';
  /**
   * Second tx invocation outcome (recovery branch only):
   *   - 'ok'        → recovery succeeded
   *   - 'failed'    → recovery INSERT or UPDATE returned err
   *   - 'thrown'    → recovery tx threw
   *   - undefined   → no second call expected
   */
  readonly recoveryOutcome?: 'ok' | 'failed' | 'thrown';
}

function makeDeps(scenario: RecoveryScenario): ImportCsvDeps {
  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    idempotencyStore: {
      tryInsert: vi.fn(async () =>
        ok({ wasFresh: false, originalProcessedAt: null }),
      ),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
    advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
  } as unknown as ImportCsvTxScopedPorts;

  // The use-case opens FOUR distinct `withImportRecordsTx` calls in the
  // recovery path (and 3 in the happy-path), in this order:
  //   1. Safety-net findByFingerprintAcrossEvents  (returns ok([])
  //                                                  — no prior imports)
  //   2. Placeholder INSERT                         (always ok)
  //   3. Placeholder UPDATE                         (scenario.firstTxOutcome
  //                                                  applies here)
  //   4. Recovery INSERT + UPDATE                    (only if step 3
  //                                                  returned not_found;
  //                                                  scenario.recoveryOutcome
  //                                                  applies here)
  // We track tx-call index + dispatch the right repo per call.
  let txCallIndex = 0;

  return {
    csvImporter: makeCsvImporterMock(
      vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'a'.repeat(64),
              row: {
                event_external_id: 'event_recovery_test',
                event_name: 'Recovery Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'recovery@example.com',
                attendee_name: 'Recovery Attendee',
                payment_status: 'paid' as const,
              },
              pdpaConsentAcknowledged: null,
              intendedStateChange: false,
            };
          })(),
        ),
      ),
    ),
    runInTenantTx: vi.fn(async (_tenantId, fn) => fn(fakeBatchPorts)),
    withImportRecordsTx: vi.fn(async (_tenantId, fn) => {
      txCallIndex += 1;
      const callIndex = txCallIndex;

      // Recovery path may throw in the outer tx (call #4 only).
      if (callIndex === 4 && scenario.recoveryOutcome === 'thrown') {
        throw new Error('simulated recovery tx threw');
      }

      const repo: CsvImportRecordsRepository = {
        findByFingerprintAcrossEvents: vi.fn(async () => ok([])),
        insert: vi.fn(async () => {
          // Call #4 (recovery) — insert may fail per scenario.
          if (callIndex === 4 && scenario.recoveryOutcome === 'failed') {
            return err({
              kind: 'db_error' as const,
              message: 'simulated recovery insert failure',
            });
          }
          return ok(undefined);
        }),
        updateOutcome: vi.fn(async () => {
          // Call #3 — placeholder UPDATE → scenario.firstTxOutcome.
          if (callIndex === 3) {
            if (scenario.firstTxOutcome === 'not_found') {
              return err({ kind: 'not_found' as const });
            }
            if (scenario.firstTxOutcome === 'db_error') {
              return err({
                kind: 'db_error' as const,
                message: 'simulated update failure',
              });
            }
            return ok(undefined);
          }
          // Call #4 — recovery UPDATE → scenario.recoveryOutcome.
          if (callIndex === 4 && scenario.recoveryOutcome === 'failed') {
            return err({
              kind: 'db_error' as const,
              message: 'simulated recovery update failure',
            });
          }
          return ok(undefined);
        }),
        setErrorCsvBlob: vi.fn(async () => ok(undefined)),
        listByTenant: vi.fn(async () =>
          ok({ items: [], pagination: { page: 1, pageSize: 50, totalCount: 0 } }),
        ),
        findById: vi.fn(async () => ok(null)),
      } as unknown as CsvImportRecordsRepository;

      return fn(repo);
    }),
    emitStandalone: vi.fn(async () => ok('audit-id' as never)),
    errorCsvStore: {
      put: vi.fn(async () => ok({ blobUrl: 'http://blob/x', expiresAt: new Date() })),
      generateSignedUrl: vi.fn(async () =>
        err({ kind: 'storage_error' as const, message: 'not used' }),
      ),
      delete: vi.fn(async () => ok(undefined)),
    } as unknown as ImportCsvDeps['errorCsvStore'],
  } as unknown as ImportCsvDeps;
}

const INPUT = {
  tenantId: asTenantId('test-chamber-recovery'),
  actorUserId: asUserId('00000000-0000-0000-0000-000000000400'),
  bytes: VALID_CSV,
  selectedEvent: f6CsvTestSelectedEventStub,
};

describe('R2 CR-5 — csv_import_records recovery INSERT path', () => {
  it('happy path: placeholder UPDATE succeeds → historyPersisted=true, no recovery tx', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ firstTxOutcome: 'ok' });
    const outcome = await importCsv(INPUT, deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.historyPersisted).toBe(true);
    }
    // 3 calls: safety-net (1) + placeholder INSERT (2) + placeholder
    // UPDATE (3) — no recovery (4) because update returned ok.
    expect(deps.withImportRecordsTx).toHaveBeenCalledTimes(3);
  });

  it('recovery succeeds: not_found → recovery INSERT succeeds → historyPersisted=true + warn log', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ firstTxOutcome: 'not_found', recoveryOutcome: 'ok' });
    const outcome = await importCsv(INPUT, deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.historyPersisted).toBe(true);
    }
    // 4 calls: safety-net + placeholder INSERT + placeholder UPDATE
    // (not_found) + recovery INSERT/UPDATE.
    expect(deps.withImportRecordsTx).toHaveBeenCalledTimes(4);
    // Warn log fires on recovery success — protects against regression
    // that drops the recovery success warn (SRE alert would be silent).
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const recoveryWarn = warnCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_import_records_recovery_succeeded',
    );
    expect(recoveryWarn).toBeDefined();
  });

  it('recovery fails: not_found → recovery INSERT err → historyPersisted=false + error log', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({
      firstTxOutcome: 'not_found',
      recoveryOutcome: 'failed',
    });
    const outcome = await importCsv(INPUT, deps);
    // Use-case STILL returns 'completed' — the rows committed are safe.
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      // R2-I4 phantom-recordId fix: false flag propagated so the route
      // + UI can degrade the recordId chip.
      expect(outcome.historyPersisted).toBe(false);
    }
    expect(deps.withImportRecordsTx).toHaveBeenCalledTimes(4);
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const recoveryFailed = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_import_records_recovery_failed',
    );
    expect(recoveryFailed).toBeDefined();
  });

  it('recovery throws: not_found → recovery tx throws → historyPersisted=false + threw log', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({
      firstTxOutcome: 'not_found',
      recoveryOutcome: 'thrown',
    });
    const outcome = await importCsv(INPUT, deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.historyPersisted).toBe(false);
    }
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const recoveryThrew = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_import_records_recovery_threw',
    );
    expect(recoveryThrew).toBeDefined();
  });

  it('placeholder UPDATE db_error (NOT not_found): no recovery, historyPersisted=false + update_failed log', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ firstTxOutcome: 'db_error' });
    const outcome = await importCsv(INPUT, deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.historyPersisted).toBe(false);
    }
    // 3 tx calls (safety-net + placeholder INSERT + placeholder
    // UPDATE-fails) — recovery path is gated on 'not_found' specifically
    // so a generic db_error must NOT trigger a 4th recovery call.
    expect(deps.withImportRecordsTx).toHaveBeenCalledTimes(3);
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const updateFailed = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_csv_import_records_update_failed',
    );
    expect(updateFailed).toBeDefined();
  });
});
