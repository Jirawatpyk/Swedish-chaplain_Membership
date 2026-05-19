/**
 * R2-I-5 close (R3 — pr-test-analyzer) — Strict-audit invariant on
 * `tryEmitMismatchOverride` (FR-019c).
 *
 * When admin re-submits the import form with `forceProceed: true` to
 * bypass the FR-019b event-mismatch safety net, the use-case MUST emit
 * `csv_import_event_mismatch_overridden` audit BEFORE committing
 * batches. If the audit emit fails (Result.err OR throw), the import
 * MUST refuse to proceed — a forceProceed without a forensic trail
 * breaks the FR-019c contract.
 *
 * R1 CR-9 implemented the boolean-return pattern (`tryEmitMismatchOverride`
 * returns false → caller returns `{kind:'unexpected_error', ...}`).
 * R2-I-5 raised that no test exercises this branch. A regression that
 * re-enabled the import despite emit failure (a real possibility —
 * earlier R1 code logged-and-continued) would ship silently.
 *
 * This test wires:
 *   - `withImportRecordsTx` returns 1 priorImport (triggers the safety-net hit)
 *   - `input.forceProceed = true` (triggers the override path)
 *   - `emitStandalone` returns Result.err on csv_import_event_mismatch_overridden
 *
 * And asserts:
 *   - outcome.kind === 'unexpected_error'
 *   - outcome.message mentions "override audit emit failed"
 *   - NO csv_import_records insert was attempted (no committed-side effects)
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

const VALID_CSV = new TextEncoder().encode(
  [
    'event_external_id,event_name,event_start,attendee_email,attendee_name',
    'evt_override,Override Test,2026-06-21T18:00:00+07:00,override@example.com,Override Attendee',
    '',
  ].join('\n'),
);

type FixtureOpts = {
  /** When true, `emitStandalone` for csv_import_event_mismatch_overridden returns Err. */
  readonly mismatchOverrideEmitFails: boolean;
  /** When true, emitStandalone throws instead of returning Result.err. */
  readonly mismatchOverrideEmitThrows?: boolean;
};

function makeDeps(opts: FixtureOpts): ImportCsvDeps {
  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    idempotencyStore: {
      tryInsert: vi.fn(async () =>
        ok({ wasFresh: true, originalProcessedAt: null }),
      ),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
    advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
  } as unknown as ImportCsvTxScopedPorts;

  return {
    csvImporter: makeCsvImporterMock(
      vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'b'.repeat(64),
              row: {
                event_external_id: 'evt_override',
                event_name: 'Override Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'override@example.com',
                attendee_name: 'Override Attendee',
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
    withImportRecordsTx: vi.fn(async (_tenantId, fn) =>
      fn({
        // Safety-net hit: pretend a prior import landed on a DIFFERENT
        // event 7 days ago with the same fingerprint.
        findByFingerprintAcrossEvents: vi.fn(async () =>
          ok([
            {
              recordId: 'prior-recordid' as never,
              eventId: 'prior-event-id' as never,
              uploadedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          ]),
        ),
        // Stubs for the other repo methods that should NEVER be called
        // on the FR-019c refuse-to-proceed path. If any of these fire,
        // the test would fail at a vi.fn().mockImplementation throw.
        insert: vi.fn(async () => {
          throw new Error(
            'csv_import_records.insert MUST NOT be called when override audit emit fails',
          );
        }),
        updateOutcome: vi.fn(),
        setErrorCsvBlob: vi.fn(),
      } as never),
    ),
    errorCsvStore: {
      put: vi.fn(),
    } as never,
    emitStandalone: vi.fn(async (entry) => {
      const eventType = (entry as { eventType?: string }).eventType;
      if (eventType === 'csv_import_event_mismatch_overridden') {
        if (opts.mismatchOverrideEmitThrows === true) {
          throw new Error('simulated emitStandalone throw on override');
        }
        if (opts.mismatchOverrideEmitFails) {
          return err({
            kind: 'db_error' as const,
            message: 'simulated override audit-emit failure',
          });
        }
      }
      return ok('audit-id' as never);
    }),
  } as unknown as ImportCsvDeps;
}

describe('R2-I-5 (R3) — tryEmitMismatchOverride strict-audit invariant (FR-019c)', () => {
  it('Result.err on override emit → outcome=unexpected_error AND no csv_import_records insert', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ mismatchOverrideEmitFails: true });
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-override-err'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000301'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
        forceProceed: true,
      },
      deps,
    );
    expect(outcome.kind).toBe('unexpected_error');
    if (outcome.kind !== 'unexpected_error') return;
    expect(outcome.message).toContain('override audit emit failed');
    // CRITICAL: refused-to-proceed means NO `withImportRecordsTx`
    // INSERT was attempted (the dummy `insert` mock throws if called).
    // We assert by checking that runInTenantTx (which runs the
    // batch) was NEVER invoked.
    expect(deps.runInTenantTx).not.toHaveBeenCalled();
  });

  it('Throw on override emit → outcome=unexpected_error AND no csv_import_records insert', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({
      mismatchOverrideEmitFails: false,
      mismatchOverrideEmitThrows: true,
    });
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-override-throw'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000302'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
        forceProceed: true,
      },
      deps,
    );
    expect(outcome.kind).toBe('unexpected_error');
    if (outcome.kind !== 'unexpected_error') return;
    expect(outcome.message).toContain('override audit emit failed');
    expect(deps.runInTenantTx).not.toHaveBeenCalled();
  });

  it('Happy path: override emit succeeds → import proceeds (batches run)', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ mismatchOverrideEmitFails: false });
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-override-ok'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000303'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
        forceProceed: true,
      },
      deps,
    );
    // Successful override audit → import committed (no batches throw
    // in this fixture's idempotency-receipt path).
    expect(outcome.kind).toBe('completed');
    expect(deps.runInTenantTx).toHaveBeenCalled();
  });
});
