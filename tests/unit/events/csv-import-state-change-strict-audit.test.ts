/**
 * R2-I-11 close (R4 — pr-test-analyzer) — Strict-audit invariant on
 * `maybeApplyStateChange` (FR-018 + PDPA Art. 30 / GDPR Art. 30).
 *
 * When admin re-uploads CSV and a row's Notes column flipped its
 * inferred payment_status (e.g. 'verifying payment' → 'Paid'), the
 * receipt-duplicate path triggers `maybeApplyStateChange`. This helper
 * MUST emit `csv_import_row_state_changed` audit BEFORE returning a
 * `state_changed` outcome. If the in-tx audit emit fails, the
 * `TxStageError('audit_emit', ...)` MUST escape the outer catch in
 * `maybeApplyStateChange` (R2-CR-2) so the savepoint rolls back the
 * UPDATE.
 *
 * R2 review flagged this as a missing integration test. The unit test
 * here covers the equivalent code path (the integration-level test
 * would require injecting a failing audit port into the composition
 * layer, which has no test seam today). The savepoint-rollback DB
 * effect is verified by the live-Neon CR-5 audit assertion in
 * `re-upload-idempotency-eventcreate.test.ts`; this unit test pins
 * the application-layer control flow.
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
    'event_external_id,event_name,event_start,attendee_email,attendee_name,payment_status',
    'evt_sc,State Change Test,2026-06-21T18:00:00+07:00,sc@example.com,SC Attendee,paid',
    '',
  ].join('\n'),
);

type FixtureOpts = {
  /** When true, `ports.audit.emit` for csv_import_row_state_changed returns Err. */
  readonly stateChangeAuditEmitFails: boolean;
};

// Module-scope capture for S-14 payload structure assertions. Reset
// inside each test via vi.clearAllMocks() + manual splice.
let capturedAuditEmits: ReadonlyArray<{
  eventType: string;
  payload: Record<string, unknown>;
}> = [];

function makeDeps(opts: FixtureOpts): ImportCsvDeps {
  // The state-change branch needs:
  //   - idempotencyStore.tryInsert returns wasFresh:false (duplicate)
  //   - registrationsRepo.findByEventAndEmail returns a row with
  //     payment_status='pending' (differs from CSV's 'paid')
  //   - registrationsRepo.updatePaymentStatus returns ok
  //   - ports.audit.emit fails on csv_import_row_state_changed
  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    idempotencyStore: {
      tryInsert: vi.fn(async () =>
        ok({ wasFresh: false, originalProcessedAt: new Date() }),
      ),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
    advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
    registrationsRepo: {
      findByEventAndEmail: vi.fn(async () =>
        // Option B+ /speckit-review follow-up — `maybeApplyStateChange`
        // now reads `persisted.match.matchedMemberId` + `quotaEffect`
        // on the state-change boundary to decide whether to credit /
        // debit quota. Match resolution is `null` here so the quota
        // branch self-guards and skips — keeping the test's focus on
        // the audit-emit invariant.
        ok({
          registrationId: 'reg-uuid' as never,
          match: { type: 'non_member', matchedMemberId: null, matchedContactId: null },
          ticket: { paymentStatus: 'pending' },
          quotaEffect: {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        } as never),
      ),
      updatePaymentStatus: vi.fn(async () =>
        ok({
          registration: {} as never,
          previousPaymentStatus: 'pending' as never,
        }),
      ),
    } as unknown as ImportCsvTxScopedPorts['registrationsRepo'],
    audit: {
      emit: vi.fn(async (entry) => {
        const typed = entry as {
          readonly eventType: string;
          readonly payload: Record<string, unknown>;
        };
        capturedAuditEmits = [
          ...capturedAuditEmits,
          { eventType: typed.eventType, payload: typed.payload },
        ];
        if (
          opts.stateChangeAuditEmitFails &&
          typed.eventType === 'csv_import_row_state_changed'
        ) {
          return err({
            kind: 'db_error' as const,
            message: 'simulated state-change audit emit failure',
          });
        }
        return ok('audit-id' as never);
      }),
    } as unknown as ImportCsvTxScopedPorts['audit'],
  } as unknown as ImportCsvTxScopedPorts;

  return {
    csvImporter: makeCsvImporterMock(
      vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'c'.repeat(64),
              row: {
                event_external_id: 'evt_sc',
                event_name: 'State Change Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'sc@example.com',
                attendee_name: 'SC Attendee',
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
    emitStandalone: vi.fn(async () => ok('audit-id' as never)),
  } as unknown as ImportCsvDeps;
}

describe('R2-I-11 (R4) — maybeApplyStateChange strict-audit invariant', () => {
  it('state-change audit emit fails → row marked as row_failed AND csvImportAuditEmitFailed bumped with state_changed label', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ stateChangeAuditEmitFails: true });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-state-change-fail'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000401'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    // The use-case still completes (DB-committed invariant) — the
    // savepoint rolled back but the outer batch tx commits the other
    // rows. Here there's only ONE row, so the import is "completed"
    // with rowsFailed=1.
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    // The row must be reported as row_failed (NOT state_changed,
    // NOT duplicate) because the savepoint rolled back when the
    // audit emit failed.
    expect(outcome.summary.rowsProcessed).toBe(0);
    expect(outcome.summary.rowsAlreadyImported).toBe(0);
    expect(outcome.summary.rowsStateChanged).toBe(0);
    expect(outcome.summary.errorRows).toHaveLength(1);
    expect(outcome.summary.errorRows[0]!.rowNumber).toBe(2);

    // The dedicated counter MUST bump with the state_changed event
    // type label so SRE dashboards alert on PDPA Art. 30 trail loss
    // separately from row-failed-audit or completed-audit failures.
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const stateChangedCounterCall = counterCalls.find(
      (c) => c[1] === 'csv_import_row_state_changed',
    );
    expect(stateChangedCounterCall).toBeDefined();
    expect(stateChangedCounterCall).toEqual([
      'test-chamber-state-change-fail',
      'csv_import_row_state_changed',
    ]);
  });

  it('state-change audit emit succeeds → row outcome state_changed; no audit-emit-failed bump', async () => {
    vi.clearAllMocks();
    capturedAuditEmits = [];
    const deps = makeDeps({ stateChangeAuditEmitFails: false });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-state-change-ok'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000402'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.summary.rowsStateChanged).toBe(1);
    expect(outcome.summary.rowsAlreadyImported).toBe(0);
    expect(outcome.summary.errorRows).toHaveLength(0);

    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const stateChangedCall = counterCalls.find(
      (c) => c[1] === 'csv_import_row_state_changed',
    );
    expect(stateChangedCall).toBeUndefined();

    // S-14 (R3): pin audit payload structure. PDPA Art. 30 + GDPR Art.
    // 30 require previousPaymentStatus + newPaymentStatus + rowHash on
    // every state-change row mutation. A regression dropping any of
    // these fields would silently break the forensic record.
    // The audit.emit mock was invoked via fakeBatchPorts.audit.emit;
    // we expose it via the deps closure so the assertion can read the
    // payload structure.
    expect(capturedAuditEmits.length).toBeGreaterThanOrEqual(1);
    const stateChangeEmit = capturedAuditEmits.find(
      (entry) => entry.eventType === 'csv_import_row_state_changed',
    );
    expect(stateChangeEmit).toBeDefined();
    if (stateChangeEmit === undefined) return;
    const payload = stateChangeEmit.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('previousPaymentStatus');
    expect(payload).toHaveProperty('newPaymentStatus');
    expect(payload).toHaveProperty('rowHash');
    expect(payload).toHaveProperty('actorUserId');
    expect(payload).toHaveProperty('rowNumber');
    expect(payload['severity']).toBe('info');
  });

  it('Phase B B12 — RAW THROW from audit.emit (not Result.err) ALSO escapes outer catch as TxStageError → savepoint rolls back', async () => {
    vi.clearAllMocks();
    capturedAuditEmits = [];
    // Build a deps variant where audit.emit THROWS (vs returns Result.err)
    // on csv_import_row_state_changed. Without B12's inner try/catch
    // wrapping audit.emit in TxStageError, the outer
    // `instanceof TxStageError` check at L600 would miss the raw throw
    // and fall through to the silent "treat as duplicate" path — a
    // PDPA Art. 30 / GDPR Art. 30 processing-records gap.
    const throwingDeps = (() => {
      const base = makeDeps({ stateChangeAuditEmitFails: false });
      // Replace the runInTenantTx to inject a throwing audit.emit only
      // for the state-change event type.
      const fakeBatchPorts: ImportCsvTxScopedPorts = {
        runRowInSavepoint: (async <T>(
          fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
        ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
        idempotencyStore: {
          tryInsert: vi.fn(async () =>
            ok({ wasFresh: false, originalProcessedAt: new Date() }),
          ),
        } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
        advisoryLockAcquirer: {
          acquire: vi.fn(async () => {}),
        } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
        registrationsRepo: {
          findByEventAndEmail: vi.fn(async () =>
            ok({
              registrationId: 'reg-uuid' as never,
              ticket: { paymentStatus: 'pending' },
            } as never),
          ),
          updatePaymentStatus: vi.fn(async () =>
            ok({
              registration: {} as never,
              previousPaymentStatus: 'pending' as never,
            }),
          ),
        } as unknown as ImportCsvTxScopedPorts['registrationsRepo'],
        audit: {
          emit: vi.fn(async (entry) => {
            const typed = entry as { readonly eventType: string };
            if (typed.eventType === 'csv_import_row_state_changed') {
              // RAW THROW (not Result.err). B12 wraps this in
              // TxStageError so the outer catch fires correctly.
              throw new Error('simulated raw throw from audit.emit');
            }
            return ok('audit-id' as never);
          }),
        } as unknown as ImportCsvTxScopedPorts['audit'],
      } as unknown as ImportCsvTxScopedPorts;
      return {
        ...base,
        runInTenantTx: vi.fn(async (_tenantId, fn) => fn(fakeBatchPorts)),
      };
    })();

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-state-change-raw-throw'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000404'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      throwingDeps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    // The row MUST surface as row_failed (savepoint rolled back) — NOT
    // duplicate (which would mean B12's TxStageError conversion was
    // missing and the raw throw fell through silently).
    expect(outcome.summary.rowsAlreadyImported).toBe(0);
    expect(outcome.summary.rowsStateChanged).toBe(0);
    expect(outcome.summary.errorRows).toHaveLength(1);
    // The strict-audit counter MUST bump.
    const counterCalls = (
      eventcreateMetrics.csvImportAuditEmitFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    const stateChangedCall = counterCalls.find(
      (c) => c[1] === 'csv_import_row_state_changed',
    );
    expect(stateChangedCall).toBeDefined();
  });

  it('R2-I-3 cross-check: NO csvImportStateChangeFallback bump on the audit-emit-failure path (different metric)', async () => {
    vi.clearAllMocks();
    const deps = makeDeps({ stateChangeAuditEmitFails: true });
    await importCsv(
      {
        tenantId: asTenantId('test-chamber-state-change-metric'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000403'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    // The fallback counter bumps on lookup-err / update-err / threw
    // paths — NOT on audit-emit-failure. Audit-emit-failure routes to
    // csvImportAuditEmitFailed (covered above) to keep SRE alerts
    // distinguishable.
    const fallbackCalls = (
      eventcreateMetrics.csvImportStateChangeFallback as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(fallbackCalls).toHaveLength(0);
    // Suppress unused import warning for logger via reference.
    void logger;
  });
});
