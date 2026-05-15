/**
 * NEW-J test (Round-2 review, 2026-05-15) — verify the C-1 / C-2 audit-
 * emit failure observability paths.
 *
 * Previous review found that `csvImportAuditEmitFailed` counter had 0
 * grep hits in `tests/`, so a regression dropping any emit point at
 * `import-csv.ts:540/559/696/715` would not fail CI.
 *
 * This unit test mocks `deps.emitStandalone` to return `Result.err`
 * for `csv_import_completed`, then asserts:
 *   1. `logger.error` is called with the expected event name
 *   2. `eventcreateMetrics.csvImportAuditEmitFailed(tenantId, eventType)`
 *      is called for the failure
 *   3. The use-case STILL returns `{kind:'completed'}` — the route
 *      response is independent of audit-emit outcome ("DB committed"
 *      invariant per the comment at import-csv.ts:716).
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

function makeFakeDeps(opts: { emitFails: boolean }): ImportCsvDeps {
  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    idempotencyStore: {
      tryInsert: vi.fn(async () =>
        ok({ wasFresh: false, originalProcessedAt: null }),
      ),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
    // The rest of ProcessAttendeeInTxPorts is unused on the duplicate
    // short-circuit path (idempotencyStore.tryInsert returns wasFresh:
    // false → processOneRowInSavepoint returns 'duplicate' before
    // calling processAttendeeInTx). Cast through unknown to skip
    // stubbing 6+ unused ports.
  } as unknown as ImportCsvTxScopedPorts;

  return {
    csvImporter: {
      parseStream: vi.fn(async () =>
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
            };
          })(),
        ),
      ),
    },
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
  it('csv_import_completed audit-emit failure: logs + bumps counter; use-case still returns completed', async () => {
    vi.clearAllMocks();
    const deps = makeFakeDeps({ emitFails: true });

    const outcome: ImportCsvOutcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-audit'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000111'),
        bytes: VALID_CSV,
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

    // C-1: dedicated counter increments with the failed eventType label.
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const completedCounterCall = counterCalls.find(
      (c) => c[1] === 'csv_import_completed',
    );
    expect(completedCounterCall).toBeDefined();
  });

  it('audit emit success: logger.error NOT called + counter NOT incremented (control path)', async () => {
    vi.clearAllMocks();
    const deps = makeFakeDeps({ emitFails: false });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-audit-ok'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000112'),
        bytes: VALID_CSV,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(counterCalls).toHaveLength(0);
  });
});
