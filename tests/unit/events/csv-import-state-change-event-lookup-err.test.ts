/**
 * R3-T4 (2026-05-18 /speckit-review Round 3 Final) — unit test for the
 * `!eventLookup.ok` branch added in R2-7. Pre-R2-7 the events-repo err
 * fell through silently into the "non-eligible event" branch, masking
 * DB-read failures. R2-7 split the branches: err now emits a structured
 * WARN log + `csvImportEventLookupFailed` metric while still failing
 * safe (no synthetic quota effect).
 *
 * This test pins:
 *   1. `eventsRepo.findById` returning err during the state-change quota
 *      gate triggers `csvImportEventLookupFailed(tenantId, 'state_change_quota_gate')`.
 *   2. `csvImportStateChangeFallback` is NOT also called (the two
 *      metric series are disjoint per R3-C3).
 *   3. The state-change UPDATE on `payment_status` still commits
 *      (fail-safe: payment_status mirrors upstream Status regardless
 *      of quota eligibility lookup outcome).
 *   4. No quota credit-back audit row is emitted (no `applyQuotaEffect`
 *      or debit branch runs when lookup fails).
 *
 * Pure Application — no DB, no framework.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import { asUserId, type AuditEventId } from '@/modules/auth';
import { asTenantId, asMemberId } from '@/modules/members';
import { eventcreateMetrics } from '@/lib/metrics';
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
    csvErrorCsvUploadFailed: vi.fn(),
    csvErrorCsvSweepClearFailed: vi.fn(),
    csvSweepScanFailed: vi.fn(),
    csvImportParserThrew: vi.fn(),
    csvImportStateChangeFallback: vi.fn(),
    csvImportEventLookupFailed: vi.fn(),
    csvImportOrphanReceiptRecovered: vi.fn(),
    csvErrorCsvDownloaded: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

const VALID_CSV = new TextEncoder().encode(
  [
    'event_external_id,event_name,event_start,attendee_email,attendee_name,payment_status',
    'evt_lookup_err,EventLookup Test,2026-06-21T18:00:00+07:00,el@example.com,EL Attendee,pending',
    '',
  ].join('\n'),
);

const MEMBER_ID = asMemberId('33333333-3333-4333-8333-333333333333');

function makeDeps(): ImportCsvDeps {
  // Set up the state-change debit path:
  //   - idempotency receipt duplicate (forces state-change branch)
  //   - persisted row payment_status='paid' (counted), CSV row='pending' (uncounted)
  //     → triggers debit path which calls eventsRepo.findById
  //   - matchedMemberId non-null (passes the early gate)
  //   - countedAgainstPartnership=true on existing row (forces debit)
  //   - eventsRepo.findById returns err (the R2-7 branch we're testing)
  //   - updatePaymentStatus returns ok (commits the payment_status flip)
  const auditEmit = vi.fn(async () =>
    ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
  );
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
          match: {
            type: 'member_contact',
            matchedMemberId: MEMBER_ID,
            matchedContactId: 'ctx-uuid' as never,
          },
          ticket: { paymentStatus: 'paid' },
          quotaEffect: {
            countedAgainstPartnership: true,
            countedAgainstCulturalQuota: false,
          },
        } as never),
      ),
      updatePaymentStatus: vi.fn(async () =>
        ok({
          registration: {} as never,
          previousPaymentStatus: 'paid' as never,
        }),
      ),
    } as unknown as ImportCsvTxScopedPorts['registrationsRepo'],
    eventsRepo: {
      findById: vi.fn(async () =>
        // R2-7 the branch under test — eventsRepo returns err.
        err({ kind: 'db_error' as const, message: 'simulated DB blip' }),
      ),
    } as unknown as ImportCsvTxScopedPorts['eventsRepo'],
    audit: { emit: auditEmit } as unknown as ImportCsvTxScopedPorts['audit'],
  } as unknown as ImportCsvTxScopedPorts;

  // R4-T4 — expose the captured `auditEmit` spy as a non-enumerable
  // property so the 4th it-block can assert on which events emitted
  // without breaking the existing 3 sites that just use `const deps =
  // makeDeps()`.
  const deps = {
    csvImporter: makeCsvImporterMock(
      vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'd'.repeat(64),
              row: {
                event_external_id: 'evt_lookup_err',
                event_name: 'EventLookup Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'el@example.com',
                attendee_name: 'EL Attendee',
                payment_status: 'pending' as const,
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
  Object.defineProperty(deps, '_auditEmitSpy', {
    value: auditEmit,
    enumerable: false,
  });
  return deps;
}

describe('R3-T4 — !eventLookup.ok in maybeApplyStateChange debit path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires csvImportEventLookupFailed with state_change_quota_gate scope', async () => {
    const deps = makeDeps();
    await importCsv(
      {
        tenantId: asTenantId('test-chamber-lookup-err'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000402'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    const calls = (
      eventcreateMetrics.csvImportEventLookupFailed as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe('state_change_quota_gate');
  });

  it('does NOT fire csvImportStateChangeFallback (R3-C3 disjoint series)', async () => {
    const deps = makeDeps();
    await importCsv(
      {
        tenantId: asTenantId('test-chamber-lookup-err'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000402'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    const calls = (
      eventcreateMetrics.csvImportStateChangeFallback as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(calls).toHaveLength(0);
  });

  it('row reports as state-changed (UPDATE committed, no quota effect)', async () => {
    const deps = makeDeps();
    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-lookup-err'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000402'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    // Fail-safe: payment_status UPDATE commits even when the quota
    // gate's events-repo lookup errs. rowsStateChanged increments.
    expect(outcome.summary.rowsStateChanged).toBe(1);
    expect(outcome.summary.errorRows).toHaveLength(0);
  });

  it('R4-T4 — emits state-change audit ONLY (no quota_credit_back_refund row when eventLookup errs)', async () => {
    const deps = makeDeps();
    await importCsv(
      {
        tenantId: asTenantId('test-chamber-lookup-err'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000402'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );
    // R4-T4 tightening — assert via the captured audit.emit spy
    // (exposed as `_auditEmitSpy` on deps). Pre-R4-T4 this it-block
    // duplicated assertions from "row reports as state-changed" and
    // provided no new coverage. Now: directly verify the audit
    // event-type stream.
    const auditEmit = (
      deps as unknown as { _auditEmitSpy: ReturnType<typeof vi.fn> }
    )._auditEmitSpy;
    const emittedEventTypes = auditEmit.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(emittedEventTypes).toContain('csv_import_row_state_changed');
    expect(emittedEventTypes).not.toContain('quota_credit_back_refund');
    expect(
      emittedEventTypes.filter((t) => t.startsWith('quota_')),
    ).toHaveLength(0);
    // Plus the match-resolution audit fires (member_contact in the
    // mock); that's transitive coverage, not the focus of this case.
  });
});
