/**
 * NEW-K test (Round-2 review, 2026-05-15) — verify the parallel batch
 * scheduler at `batchConcurrency=3`.
 *
 * Round-2 review noted that `H-10 — time-budget short-circuit semantics`
 * uses `batchConcurrency: 1` (serial), so the default sliding-window
 * scheduler at 3 was never exercised by tests. A concurrency race / wrong
 * scheduler implementation would have shipped silently.
 *
 * This unit test:
 *   1. Wires fake deps where `runInTenantTx` resolves after a recorded
 *      delay and tracks concurrent-call peak via in-flight counter.
 *   2. Submits a CSV that splits into 6 batches at `batchSize: 1`.
 *   3. Asserts:
 *        a. `runInTenantTx` is called 6 times (one per batch).
 *        b. Peak in-flight concurrency reaches >= 2 (proves the
 *           sliding-window worker pool actually overlaps work; serial
 *           mode would max at 1).
 *        c. Outcome `summary.rowsAlreadyImported === 6` (all rows
 *           short-circuit at idempotency duplicate; each non-zero
 *           progress proves the worker pool drained the queue).
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { f6CsvTestSelectedEventStub } from './_helpers/f6-csv-test-fixtures';

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
    createEventDurationSeconds: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

function buildCsv(rows: number): Uint8Array {
  const header =
    'event_external_id,event_name,event_start,attendee_email,attendee_name';
  const lines: string[] = [header];
  for (let i = 0; i < rows; i++) {
    lines.push(
      `event_par_${i},Parallel Test,2026-06-21T18:00:00+07:00,par_${i}@example.com,Parallel Attendee ${i}`,
    );
  }
  return new TextEncoder().encode(lines.join('\n'));
}

function makeConcurrencyTrackingDeps(): {
  deps: ImportCsvDeps;
  callTracker: { inFlight: number; peakInFlight: number; totalCalls: number };
} {
  const callTracker = { inFlight: 0, peakInFlight: 0, totalCalls: 0 };

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
    csvImporter: {
      parseStream: vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
        // Hand-parse the test CSV: skip header, yield ParsedRow per data line.
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
              };
            }
          })(),
        );
      }),
    },
    runInTenantTx: vi.fn(
      async (
        _tenantId: string,
        fn: (ports: ImportCsvTxScopedPorts) => Promise<unknown>,
      ) => {
        callTracker.totalCalls += 1;
        callTracker.inFlight += 1;
        callTracker.peakInFlight = Math.max(
          callTracker.peakInFlight,
          callTracker.inFlight,
        );
        try {
          // Yield several microtasks so other workers can interleave
          // their `runInTenantTx` calls before this one resolves.
          // Without yielding, the synchronous `Promise.all(workers)`
          // resolves each worker's first batch before scheduling the
          // next — masking real-world overlap behaviour.
          for (let yieldI = 0; yieldI < 5; yieldI++) {
            await Promise.resolve();
          }
          return await fn(fakeBatchPorts);
        } finally {
          callTracker.inFlight -= 1;
        }
      },
    ),
    emitStandalone: vi.fn(async () => ok('audit-id' as never)),
  } as unknown as ImportCsvDeps;

  return { deps, callTracker };
}

describe('NEW-K — parallel batch scheduler', () => {
  it('batchConcurrency=3 overlaps batches (peak in-flight ≥ 2)', async () => {
    const { deps, callTracker } = makeConcurrencyTrackingDeps();
    const csvBytes = buildCsv(6); // 6 rows × batchSize=1 → 6 batches

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-par'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000201'),
        bytes: csvBytes,
        selectedEvent: f6CsvTestSelectedEventStub,
        batchSize: 1, // every row = its own batch
        batchConcurrency: 3,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    expect(callTracker.totalCalls).toBe(6);
    // Sliding-window pool at concurrency=3 — peak should reach 3 on a
    // healthy implementation. Allow ≥ 2 to tolerate scheduler-jitter
    // edge cases while still ruling out the serial=1 regression.
    expect(callTracker.peakInFlight).toBeGreaterThanOrEqual(2);
    // Upper bound: rule out a "no-cap" regression where someone
    // refactors the worker pool into `Promise.all(batches.map(...))`
    // and silently saturates the connection pool. peakInFlight must
    // never exceed batchConcurrency=3.
    expect(callTracker.peakInFlight).toBeLessThanOrEqual(3);
    if (outcome.kind === 'completed') {
      expect(outcome.summary.rowsAlreadyImported).toBe(6);
    }
  });

  it('batchConcurrency=2 caps peak at 2 (disambiguates cap value)', async () => {
    const { deps, callTracker } = makeConcurrencyTrackingDeps();
    const csvBytes = buildCsv(6);

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-par-2'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000203'),
        bytes: csvBytes,
        selectedEvent: f6CsvTestSelectedEventStub,
        batchSize: 1,
        batchConcurrency: 2,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    expect(callTracker.totalCalls).toBe(6);
    // Strict equality — at batchConcurrency=2 with 6 batches and
    // microtask-yield mocks, the pool MUST peak at exactly 2. This
    // disambiguates "≥ 2" from "= 3" in the headline test above and
    // proves the cap value actually drives the scheduler.
    expect(callTracker.peakInFlight).toBe(2);
  });

  it('batchConcurrency=1 produces strictly serial execution (control path)', async () => {
    const { deps, callTracker } = makeConcurrencyTrackingDeps();
    const csvBytes = buildCsv(4);

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-par-serial'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000202'),
        bytes: csvBytes,
        selectedEvent: f6CsvTestSelectedEventStub,
        batchSize: 1,
        batchConcurrency: 1,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    expect(callTracker.totalCalls).toBe(4);
    expect(callTracker.peakInFlight).toBe(1);
  });
});
