/**
 * F9 US5 (T071) — `processExportJob` worker unit tests (mocked deps).
 *
 * Pins the failure/race orchestration that the live-Neon worker integration
 * (in-memory blob stub) doesn't exercise — the paths fixed in the Round-1
 * review:
 *   - build error → `failed` + blob cleanup + metric (Gap E / FR-037 no silent failure)
 *   - markReady lost-race (0 rows) → NOT ok; blob deleted; err('lost_claim') (C1)
 *   - unsupported kind → `failed` (Gap F)
 *   - claim guards: not_found, not-claimable status (lost_claim)
 *   - markFailed throwing inside the catch is swallowed-but-logged, not rethrown (H2)
 *
 * `@/lib/db` is mocked to a runInTenant pass-through so the whole use-case runs
 * without a database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

// Metrics are a module singleton (not an injected dep) but are the operator's
// only signal that a job died (FR-037 no-silent-failure), so assert the labels.
const metricsMock = vi.hoisted(() => ({
  exportJobProcessed: vi.fn(),
  exportJobDurationMs: vi.fn(),
}));
vi.mock('@/lib/metrics', () => ({
  insightsMetrics: {
    exportJobProcessed: metricsMock.exportJobProcessed,
    exportJobDurationMs: metricsMock.exportJobDurationMs,
  },
}));

// Mock the logger so the failure-path assertions can verify the structured log
// lines (mark_failed_lost vs mark_failed_failed) and to keep the suite quiet.
const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ logger: loggerMock }));

beforeEach(() => {
  metricsMock.exportJobProcessed.mockClear();
  metricsMock.exportJobDurationMs.mockClear();
  loggerMock.error.mockClear();
});

const { asTenantContext } = await import('@/modules/tenants');
const { processExportJob } = await import(
  '@/modules/insights/application/use-cases/process-export-job'
);
type ProcessExportJobDeps = import('@/modules/insights/application/use-cases/process-export-job').ProcessExportJobDeps;
type ExportJobRecord = import('@/modules/insights/application/ports/export-job-repo').ExportJobRecord;
type ExportKind = import('@/modules/insights/domain/export-job').ExportKind;

const ctx = asTenantContext('test-tenant');
const JOB_ID = '11111111-1111-1111-1111-111111111111';

function job(kind: ExportKind, status: ExportJobRecord['status'] = 'requested'): ExportJobRecord {
  return {
    id: JOB_ID,
    tenantId: 'test-tenant',
    kind,
    subjectMemberId: kind === 'gdpr_member_archive' ? 'mem-1' : null,
    requestedBy: 'u-1',
    requestedForPeriod: null,
    requesterLocale: kind === 'gdpr_member_archive' ? 'en' : null,
    status,
    idempotencyKey: 'k',
    blobKey: null,
    downloadTokenHash: null,
    expiresAt: null,
    errorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Mocks {
  deps: ProcessExportJobDeps;
  exportJobRepo: Record<string, ReturnType<typeof vi.fn>>;
  blob: Record<string, ReturnType<typeof vi.fn>>;
  audit: Record<string, ReturnType<typeof vi.fn>>;
  artefact: Record<string, ReturnType<typeof vi.fn>>;
  gdprArchive: Record<string, ReturnType<typeof vi.fn>>;
}

function makeMocks(opts: {
  jobRecord: ExportJobRecord | null;
  claimed?: boolean;
  markReady?: boolean;
  buildThrows?: boolean;
  markFailedThrows?: boolean;
  markFailedReturnsFalse?: boolean;
  gdprNotFound?: boolean;
}): Mocks {
  const exportJobRepo = {
    acquireJobLockInTx: vi.fn().mockResolvedValue(undefined),
    findByIdInTx: vi.fn().mockResolvedValue(opts.jobRecord),
    claimInTx: vi.fn().mockResolvedValue(opts.claimed ?? true),
    markReadyInTx: vi.fn().mockResolvedValue(opts.markReady ?? true),
    markFailedInTx: opts.markFailedThrows
      ? vi.fn().mockRejectedValue(new Error('neon down'))
      : vi.fn().mockResolvedValue(!opts.markFailedReturnsFalse),
  };
  const blob = {
    putPrivate: vi.fn().mockResolvedValue({ key: 'k' }),
    delete: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(),
  };
  const audit = {
    recordInTx: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
  };
  const artefact = {
    buildJson: opts.buildThrows
      ? vi.fn().mockRejectedValue(new Error('render failed'))
      : vi.fn().mockResolvedValue({
          bytes: new Uint8Array([1, 2, 3]),
          contentType: 'application/json',
          extension: 'json',
        }),
    buildEbookPdf: vi.fn(),
  };
  const directoryRepo = { listPublishedInTx: vi.fn().mockResolvedValue([]) };
  const gdprArchive = {
    buildArchiveForMember: opts.gdprNotFound
      ? vi.fn().mockResolvedValue({ ok: false, error: 'member_not_found' })
      : opts.buildThrows
        ? vi.fn().mockRejectedValue(new Error('gather failed'))
        : vi.fn().mockResolvedValue({
            ok: true,
            value: { bytes: new Uint8Array([0x50, 0x4b]), contentType: 'application/zip' },
          }),
  };
  const deps = {
    exportJobRepo,
    directoryRepo,
    artefact,
    gdprArchive,
    blob,
    audit,
    clock: { now: () => new Date() },
    tenantName: 'SweCham',
    tenantDefaultLocale: 'en',
  } as unknown as ProcessExportJobDeps;
  return { deps, exportJobRepo, blob, audit, artefact, gdprArchive };
}

describe('processExportJob — claim guards', () => {
  it('not_found when the job is absent', async () => {
    const { deps } = makeMocks({ jobRecord: null });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');
  });

  it('lost_claim when the job is not in a claimable state', async () => {
    const { deps, artefact } = makeMocks({ jobRecord: job('directory_json', 'processing') });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('lost_claim');
    expect(artefact.buildJson).not.toHaveBeenCalled();
  });

  it('lost_claim when claimInTx matches 0 rows (the real concurrent-worker race)', async () => {
    // Status IS claimable, so the defence check passes — but the authoritative
    // SQL claim loses the race: another worker claimed it between findById and
    // claimInTx. This is the branch the not-claimable test above does NOT cover.
    const { deps, exportJobRepo, artefact } = makeMocks({
      jobRecord: job('directory_json'),
      claimed: false,
    });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('lost_claim');
    expect(exportJobRepo.claimInTx).toHaveBeenCalledOnce(); // reached the SQL claim
    expect(artefact.buildJson).not.toHaveBeenCalled(); // never built on a lost claim
  });

  it('unsupported_kind → failed (Gap F) — audit_export is not handled here', async () => {
    const { deps, exportJobRepo } = makeMocks({ jobRecord: job('audit_export') });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unsupported_kind');
    expect(exportJobRepo.markFailedInTx).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      'unsupported_kind',
    );
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'audit_export',
      'failed',
      'test-tenant',
    );
  });

  it('unsupported_kind: a failing markFailed is swallowed (logged), not rethrown', async () => {
    const { deps } = makeMocks({
      jobRecord: job('audit_export'),
      markFailedThrows: true,
    });
    // Mirrors H2 for the unsupported-kind branch: the guarded mark may throw, but
    // it must not escape the cron's per-job loop — still resolves to err.
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unsupported_kind');
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'audit_export',
      'failed',
      'test-tenant',
    );
  });

  it('gdpr_member_archive → ready: builds, uploads zip, emits data_export_generated', async () => {
    const { deps, exportJobRepo, blob, audit, gdprArchive } = makeMocks({
      jobRecord: job('gdpr_member_archive'),
    });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(true);
    expect(gdprArchive.buildArchiveForMember).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ subjectMemberId: 'mem-1', requesterLocale: 'en' }),
    );
    // zip uploaded under a .zip key.
    expect(blob.putPrivate).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/zip' }),
    );
    const putArgs = blob.putPrivate!.mock.calls[0]![0] as { key: string };
    expect(putArgs.key).toContain('.zip');
    // markReady + the data_export_generated audit event.
    expect(exportJobRepo.markReadyInTx).toHaveBeenCalled();
    const event = audit.recordInTx!.mock.calls[0]![1] as {
      eventType: string;
      payload: { subject_member_id: string };
    };
    expect(event.eventType).toBe('data_export_generated');
    expect(event.payload.subject_member_id).toBe('mem-1');
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'gdpr_member_archive',
      'ok',
      'test-tenant',
    );
  });

  it('gdpr_member_archive with null requesterLocale → builds with tenantDefaultLocale (staff-review)', async () => {
    const noLocale = { ...job('gdpr_member_archive'), requesterLocale: null };
    const { deps, gdprArchive } = makeMocks({ jobRecord: noLocale });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(true);
    expect(gdprArchive.buildArchiveForMember).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ requesterLocale: 'en' }), // tenantDefaultLocale fallback
    );
  });

  it('gdpr_member_archive with null subjectMemberId → failed (member_not_found), no build (S2)', async () => {
    // A malformed GDPR enqueue (null subject) must fail loud, never build/upload.
    const malformed = { ...job('gdpr_member_archive'), subjectMemberId: null };
    const { deps, exportJobRepo, blob, gdprArchive } = makeMocks({ jobRecord: malformed });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('member_not_found');
    expect(gdprArchive.buildArchiveForMember).not.toHaveBeenCalled();
    expect(blob.putPrivate).not.toHaveBeenCalled();
    expect(exportJobRepo.markFailedInTx).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      'member_not_found',
    );
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'gdpr_member_archive',
      'failed',
      'test-tenant',
    );
  });

  it('gdpr_member_archive: member_not_found → failed + data_export_failed, no upload', async () => {
    const { deps, exportJobRepo, blob, audit } = makeMocks({
      jobRecord: job('gdpr_member_archive'),
      gdprNotFound: true,
    });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('member_not_found');
    expect(blob.putPrivate).not.toHaveBeenCalled();
    expect(exportJobRepo.markFailedInTx).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      'member_not_found',
    );
    const failedEvent = audit.record!.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === 'data_export_failed',
    );
    expect(failedEvent).toBeDefined();
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'gdpr_member_archive',
      'failed',
      'test-tenant',
    );
    // Lock the once-invariant (R2-4): a failure branch must meter exactly once
    // (no double-emit via failJob + a stray sibling path).
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledTimes(1);
  });
});

describe('processExportJob — build/ready paths', () => {
  it('happy path: build → upload → markReady → audit → ok', async () => {
    const { deps, blob, audit } = makeMocks({ jobRecord: job('directory_json') });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(true);
    expect(blob.putPrivate).toHaveBeenCalledOnce();
    expect(audit.recordInTx).toHaveBeenCalledOnce(); // directory_json_exported
    expect(blob.delete).not.toHaveBeenCalled();
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'directory_json',
      'ok',
      'test-tenant',
    );
    expect(metricsMock.exportJobDurationMs).toHaveBeenCalledOnce();
  });

  it('C1: markReady matches 0 rows (lost race) → NOT ok, blob deleted, no audit', async () => {
    const { deps, blob, audit } = makeMocks({ jobRecord: job('directory_json'), markReady: false });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('lost_claim');
    expect(blob.delete).toHaveBeenCalledOnce(); // orphan artefact cleaned up (C2)
    expect(audit.recordInTx).not.toHaveBeenCalled(); // no success audit on a lost race
    // Never meter 'ok' / duration on a lost race — only 'failed'.
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'directory_json',
      'failed',
      'test-tenant',
    );
    expect(metricsMock.exportJobDurationMs).not.toHaveBeenCalled();
  });

  it('Gap E: build throws → failed + blob cleanup + build_failed (FR-037 no silent failure)', async () => {
    const { deps, blob, exportJobRepo } = makeMocks({
      jobRecord: job('directory_json'),
      buildThrows: true,
    });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('build_failed');
    expect(exportJobRepo.markFailedInTx).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      'build_failed',
    );
    expect(blob.delete).toHaveBeenCalledOnce(); // C2 orphan cleanup (no-op if never uploaded)
    expect(metricsMock.exportJobProcessed).toHaveBeenCalledWith(
      'directory_json',
      'failed',
      'test-tenant',
    );
  });

  it('build_failed + markFailed matches 0 rows (lost mark) → logs mark_failed_lost, not mark_failed_failed', async () => {
    // A concurrent reclaim/expire moved the row out of processing between the
    // build throw and the failure-mark, so the guarded UPDATE matches 0 rows.
    const { deps } = makeMocks({
      jobRecord: job('directory_json'),
      buildThrows: true,
      markFailedReturnsFalse: true,
    });
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('build_failed'); // original error still returned
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
      'insights.export_job.mark_failed_lost',
    );
    expect(loggerMock.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'insights.export_job.mark_failed_failed', // a 0-row guard is NOT a throw
    );
  });

  it('H2: a failing markFailed inside the catch is swallowed (logged), not rethrown', async () => {
    const { deps } = makeMocks({
      jobRecord: job('directory_json'),
      buildThrows: true,
      markFailedThrows: true,
    });
    // Must still resolve to err('build_failed'), never reject.
    const r = await processExportJob(JOB_ID, ctx, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('build_failed');
  });
});
