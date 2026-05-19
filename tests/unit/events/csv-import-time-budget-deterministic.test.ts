/**
 * NEW-L test (Round-2 review, 2026-05-15) — deterministic time-budget
 * short-circuit semantics.
 *
 * Round-2 review flagged that `tests/integration/events/import-csv-time-budget.test.ts`
 * accepts a "completed" outcome as a silent-pass fallback when the
 * bench machine resolves all 6 batches before the 8s budget bites
 * (line 96-98). That gives ENVIRONMENT-DEPENDENT coverage of the
 * timeout path: on prod-region runners (intra-region Neon RTT ~5-10ms)
 * the budget never bites, so the assertion is effectively a no-op.
 *
 * This unit test fixes the coverage gap by mocking `runInTenantTx` to
 * advance a CONTROLLED clock past the time budget BEFORE the next
 * batch picks up. The scheduler's `if (Date.now() - startedAtMs >
 * timeBudgetMs) { timeBudgetExceeded = true; return; }` check inside
 * the worker loop then trips deterministically regardless of bench-
 * machine speed.
 *
 * Approach (instead of `vi.useFakeTimers()` which would freeze the
 * await-resolve scheduler):
 *   - Stub `Date.now` so each call increments the simulated clock by
 *     a fixed delta. The use-case's wall-clock check sees synthetic
 *     time advance without us controlling the microtask queue.
 *   - Each `runInTenantTx` invocation advances the clock by 5_000ms.
 *     With `timeBudgetMs=8_000` and `batchConcurrency=1` (serial), the
 *     2nd batch's wall-clock check sees `Date.now() - start = 10_000ms
 *     > 8_000ms` → `timeBudgetExceeded=true` → worker returns →
 *     `Promise.all` resolves → use-case returns `{kind:'timeout'}`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
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
    // R1 (silent-failure) — new metric stubs
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
      `event_tb_${i},Time Budget Test,2026-06-21T18:00:00+07:00,tb_${i}@example.com,Attendee ${i}`,
    );
  }
  return new TextEncoder().encode(lines.join('\n'));
}

describe('NEW-L — deterministic time-budget short-circuit (no flaky env-dependent fallback)', () => {
  let mockedClock: number;

  beforeEach(() => {
    mockedClock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockedClock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advances clock past timeBudgetMs between batches → returns {kind:"timeout"}', async () => {
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
      runInTenantTx: vi.fn(
        async (
          _tenantId: string,
          fn: (ports: ImportCsvTxScopedPorts) => Promise<unknown>,
        ) => {
          // Simulate a 5s batch — the use-case's next-batch check sees
          // wall-clock advance past the 8s budget after this call.
          mockedClock += 5_000;
          return fn(fakeBatchPorts);
        },
      ),
      emitStandalone: vi.fn(async () => ok('audit-id' as never)),
    } as unknown as ImportCsvDeps;

    // 3 rows / batchSize=1 = 3 batches. Serial (concurrency=1) so the
    // wall-clock check fires AFTER batch 1 (clock=1_005_000) ✓ and
    // AGAIN before batch 2 (clock=1_005_000 ≤ start+8_000=1_008_000) →
    // batch 2 runs (clock=1_010_000). Before batch 3, clock=1_010_000 >
    // start+8_000=1_008_000 → timeBudgetExceeded=true → return.
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-tb'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000301'),
        bytes: buildCsv(3),
        selectedEvent: f6CsvTestSelectedEventStub,
        batchSize: 1,
        batchConcurrency: 1,
        timeBudgetMs: 8_000,
      },
      deps,
    );

    // Deterministic — the env-dependent fallback at integration-test
    // line 96-98 is replaced by a contract on the use-case's own
    // wall-clock logic.
    expect(outcome.kind).toBe('timeout');
    // Only batches 1 + 2 ran (batch 3 short-circuited).
    expect(
      (deps.runInTenantTx as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2);
  });

  it('clock stays under budget → returns {kind:"completed"} (control path)', async () => {
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
                  rowHash: (i + 100).toString(16).padStart(64, '0'),
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
          mockedClock += 1_000;
          return fn(fakeBatchPorts);
        },
      ),
      emitStandalone: vi.fn(async () => ok('audit-id' as never)),
    } as unknown as ImportCsvDeps;

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-tb-ok'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000302'),
        bytes: buildCsv(3),
        selectedEvent: f6CsvTestSelectedEventStub,
        batchSize: 1,
        batchConcurrency: 1,
        timeBudgetMs: 10_000,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    expect(
      (deps.runInTenantTx as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(3);
  });
});
