/**
 * 059-membership-suspension Task 17 — F6 CSV import alert-only
 * suspended/terminated-member observability.
 *
 * When the CSV importer matches an attendee row to a member whose F8
 * benefit-access (`deriveMembershipAccess`) is `suspended` or
 * `terminated`, the row is STILL recorded normally (the event already
 * happened — F6 never blocks on membership state), but the import
 * result flags it (`summary.suspendedMemberWarnings`) and a
 * `event_attendance_by_suspended_member` audit event fires. F6 event
 * benefits are fulfilled externally, so there is nothing to gate here —
 * this is pure observability.
 *
 * `processAttendeeInTx` (the shared match+insert helper, already
 * covered end-to-end by other unit + live-Neon suites) is mocked out so
 * this test stays scoped to the NEW post-insert membership-access check
 * added to `import-csv.ts`'s fresh-insert branch.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  importCsv,
  type ImportCsvDeps,
  type ImportCsvTxScopedPorts,
} from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId, asMemberId } from '@/modules/members';
import { asRegistrationId } from '@/modules/events';
import { logger } from '@/lib/logger';
import {
  f6CsvTestSelectedEventStub,
  makeCsvImporterMock,
} from './_helpers/f6-csv-test-fixtures';

const { mockProcessAttendeeInTx } = vi.hoisted(() => ({
  mockProcessAttendeeInTx: vi.fn(),
}));

vi.mock(
  '@/modules/events/application/use-cases/_helpers/process-attendee-in-tx',
  async () => {
    const actual = await vi.importActual<
      typeof import('@/modules/events/application/use-cases/_helpers/process-attendee-in-tx')
    >(
      '@/modules/events/application/use-cases/_helpers/process-attendee-in-tx',
    );
    return {
      ...actual,
      processAttendeeInTx: mockProcessAttendeeInTx,
    };
  },
);

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
    'event_susp_test,Suspended Test,2026-06-21T18:00:00+07:00,susp@example.com,Susp Attendee',
    '',
  ].join('\n'),
);

const MATCHED_MEMBER_ID = asMemberId('22222222-2222-4222-8222-222222222222');
const REGISTRATION_ID = asRegistrationId('11111111-1111-4111-8111-111111111111');

function makeFakeEventsRepo() {
  return {
    findById: vi.fn(async () =>
      ok({
        tenantId: 'test-chamber-susp',
        eventId: f6CsvTestSelectedEventStub.eventId,
        source: 'admin_manual',
        externalId: f6CsvTestSelectedEventStub.externalId,
        name: f6CsvTestSelectedEventStub.name,
        description: null,
        startDate: f6CsvTestSelectedEventStub.startDate,
        endDate: null,
        location: null,
        category: null,
        eventcreateUrl: null,
        isPartnerBenefit: false,
        isCulturalEvent: false,
        archivedAt: null,
        metadata: {},
        importedAt: new Date(),
        lastUpdatedAt: new Date(),
      }),
    ),
  };
}

interface FakeDepsOpts {
  readonly getMembershipAccess: ReturnType<typeof vi.fn>;
  /** `false` yields an `unmatched`/non-member row (matchedMemberId: null). */
  readonly matched?: boolean;
}

function makeFakeDeps(opts: FakeDepsOpts): {
  deps: ImportCsvDeps;
  auditEmit: ReturnType<typeof vi.fn>;
} {
  const auditEmit = vi.fn(async () => ok('audit-id' as never));
  const fakeEventsRepo = makeFakeEventsRepo();

  mockProcessAttendeeInTx.mockResolvedValue({
    registrationId: REGISTRATION_ID,
    eventCreated: false,
    eventBound: true,
    matchType: opts.matched === false ? 'unmatched' : 'member_domain',
    matchedMemberId: opts.matched === false ? null : MATCHED_MEMBER_ID,
    quotaEffect: {
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
    },
    isNewRegistration: true,
  });

  const fakeBatchPorts: ImportCsvTxScopedPorts = {
    runRowInSavepoint: (async <T>(
      fn: (sp: ImportCsvTxScopedPorts) => Promise<T>,
    ) => fn(fakeBatchPorts)) as ImportCsvTxScopedPorts['runRowInSavepoint'],
    eventsRepo: fakeEventsRepo as unknown as ImportCsvTxScopedPorts['eventsRepo'],
    idempotencyStore: {
      tryInsert: vi.fn(async () => ok({ wasFresh: true, originalProcessedAt: null })),
    } as unknown as ImportCsvTxScopedPorts['idempotencyStore'],
    advisoryLockAcquirer: {
      acquire: vi.fn(async () => {}),
    } as unknown as ImportCsvTxScopedPorts['advisoryLockAcquirer'],
    audit: {
      emit: auditEmit,
    } as unknown as ImportCsvTxScopedPorts['audit'],
    membershipAccess: {
      getMembershipAccess: opts.getMembershipAccess,
    } as unknown as ImportCsvTxScopedPorts['membershipAccess'],
  } as unknown as ImportCsvTxScopedPorts;

  const deps = {
    csvImporter: makeCsvImporterMock(vi.fn(async () =>
        ok(
          (async function* () {
            yield {
              ok: true as const,
              rowNumber: 2,
              rowHash: 'b'.repeat(64),
              row: {
                event_external_id: 'event_susp_test',
                event_name: 'Suspended Test',
                event_start: '2026-06-21T18:00:00+07:00',
                attendee_email: 'susp@example.com',
                attendee_name: 'Susp Attendee',
                payment_status: 'paid' as const,
              },
              pdpaConsentAcknowledged: null,
              intendedStateChange: false,
            };
          })(),
        ),
      )),
    runInTenantTx: vi.fn(async (_tenantId, fn) => fn(fakeBatchPorts)),
    emitStandalone: vi.fn(async () => ok('audit-id' as never)),
  } as unknown as ImportCsvDeps;

  return { deps, auditEmit };
}

describe('059-membership-suspension Task 17 — suspended/terminated member CSV-import warning', () => {
  it('matched SUSPENDED member: row recorded normally + warning + audit event fired', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () =>
      ok({ access: 'suspended' as const, reason: 'unpaid' as const }),
    );
    const { deps, auditEmit } = makeFakeDeps({ getMembershipAccess });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000301'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    // Never blocks — the row IS recorded (not skipped/failed).
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.rowsFailed).toBe(0);
    expect(outcome.summary.rowsSkipped).toBe(0);

    // Flagged in the import result.
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(1);
    expect(outcome.summary.suspendedMemberWarnings[0]).toMatchObject({
      rowNumber: 2,
      memberId: MATCHED_MEMBER_ID,
      accessState: 'suspended',
    });

    // Audit event fired once with the expected shape.
    expect(getMembershipAccess).toHaveBeenCalledWith(
      'test-chamber-susp',
      MATCHED_MEMBER_ID,
    );
    const call = auditEmit.mock.calls.find(
      (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
    );
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      eventType: 'event_attendance_by_suspended_member',
      tenantId: 'test-chamber-susp',
      actorType: 'csv_import',
      payload: {
        registrationId: REGISTRATION_ID,
        matchedMemberId: MATCHED_MEMBER_ID,
        accessState: 'suspended',
      },
    });
  });

  it('matched TERMINATED member: row recorded normally + warning + audit event fired', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () =>
      ok({ access: 'terminated' as const, reason: 'grace_expired' as const }),
    );
    const { deps, auditEmit } = makeFakeDeps({ getMembershipAccess });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000302'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(1);
    expect(outcome.summary.suspendedMemberWarnings[0]).toMatchObject({
      accessState: 'terminated',
    });
    const call = auditEmit.mock.calls.find(
      (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
    );
    expect(call).toBeDefined();
    expect(call![0].payload).toMatchObject({ accessState: 'terminated' });
  });

  it('matched FULL-access member: no warning, no audit event', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () =>
      ok({ access: 'full' as const, reason: 'in_good_standing' as const }),
    );
    const { deps, auditEmit } = makeFakeDeps({ getMembershipAccess });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000303'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(0);
    expect(
      auditEmit.mock.calls.find(
        (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
      ),
    ).toBeUndefined();
  });

  it('unmatched attendee (no matchedMemberId): unaffected — membership-access lookup never invoked', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () =>
      ok({ access: 'suspended' as const, reason: 'unpaid' as const }),
    );
    const { deps, auditEmit } = makeFakeDeps({
      getMembershipAccess,
      matched: false,
    });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000304'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(0);
    expect(getMembershipAccess).not.toHaveBeenCalled();
    expect(
      auditEmit.mock.calls.find(
        (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
      ),
    ).toBeUndefined();
  });

  it('membership-access lookup FAILS: fails open (no warning), row still recorded, logs a warning', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () =>
      err({ kind: 'membership_access.lookup_error' as const }),
    );
    const { deps, auditEmit } = makeFakeDeps({ getMembershipAccess });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000305'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    // Never blocks — the row IS still recorded even though the
    // observability check itself failed.
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(0);
    expect(
      auditEmit.mock.calls.find(
        (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
      ),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('membership-access lookup THROWS (port contract violation): fails open — registration still recorded, not rolled back, no warning, no audit, logs a warning', async () => {
    vi.clearAllMocks();
    const getMembershipAccess = vi.fn(async () => {
      throw new Error('boom: adapter contract violated');
    });
    const { deps, auditEmit } = makeFakeDeps({ getMembershipAccess });

    const outcome = await importCsv(
      {
        tenantId: asTenantId('test-chamber-susp'),
        actorUserId: asUserId('00000000-0000-0000-0000-000000000306'),
        bytes: VALID_CSV,
        selectedEvent: f6CsvTestSelectedEventStub,
      },
      deps,
    );

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    // The throw must NOT propagate to the savepoint catch-all and roll
    // back the already-inserted registration — the row stays recorded,
    // not failed/skipped.
    expect(outcome.summary.rowsProcessed).toBe(1);
    expect(outcome.summary.rowsFailed).toBe(0);
    expect(outcome.summary.rowsSkipped).toBe(0);

    // No warning added (same fail-open shape as the `err(...)` case).
    expect(outcome.summary.suspendedMemberWarnings).toHaveLength(0);

    // No forensic audit event either — the throw happened before the
    // audit-emit try/catch further down ever ran.
    expect(
      auditEmit.mock.calls.find(
        (c) => c[0]?.eventType === 'event_attendance_by_suspended_member',
      ),
    ).toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });
});
