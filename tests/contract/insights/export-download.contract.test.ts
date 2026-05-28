/**
 * F9 (T073a) — download-proxy authorization matrix contract test (security-critical).
 *
 * Pins the `downloadExport` + `prepareExportDownload` authz decisions (analyze
 * R2-M2): 403 wrong subject/role · 404 unknown · 409 not-ready · 410 expired/
 * swept · invalid/consumed token · single-use consume on success. The 401
 * no-session branch lives in the route (session check before the use-case).
 *
 * `@/lib/db` is mocked to a runInTenant pass-through and `@/lib/env` provides the
 * token secret, so the whole use-case (incl. the consume + audit write path) is
 * exercised without a database.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { insights: { exportDownloadTokenSecret: 'a'.repeat(48) } },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

const { asTenantContext } = await import('@/modules/tenants');
const { hashDownloadToken, mintDownloadToken } = await import(
  '@/lib/export-download-token'
);
const { downloadExport, prepareExportDownload } = await import(
  '@/modules/insights/application/use-cases/download-export'
);
type DownloadExportMeta = import('@/modules/insights/application/use-cases/download-export').DownloadExportMeta;
type ExportJobRecord = import('@/modules/insights/application/ports/export-job-repo').ExportJobRecord;
type ExportJobRepo = import('@/modules/insights/application/ports/export-job-repo').ExportJobRepo;
type PrivateBlobPort = import('@/modules/insights/application/ports/private-blob-port').PrivateBlobPort;

const ctx = asTenantContext('test-tenant');
const JOB_ID = '11111111-1111-1111-1111-111111111111';

function job(overrides: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: JOB_ID,
    tenantId: 'test-tenant',
    kind: 'directory_json',
    subjectMemberId: null,
    requestedBy: 'u-1',
    requestedForPeriod: null,
    status: 'ready',
    idempotencyKey: 'k',
    blobKey: `exports/test-tenant/${JOB_ID}.json`,
    downloadTokenHash: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    errorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function stubRepo(jobRecord: ExportJobRecord | null): ExportJobRepo {
  return {
    createOrGetInTx: vi.fn(),
    acquireJobLockInTx: vi.fn(),
    findById: vi.fn().mockResolvedValue(jobRecord),
    findByIdInTx: vi.fn(),
    listRequestedIds: vi.fn(),
    claimInTx: vi.fn(),
    markReadyInTx: vi.fn(),
    markFailedInTx: vi.fn(),
    setDownloadTokenInTx: vi.fn().mockResolvedValue(true),
    consumeForDownloadInTx: vi.fn().mockResolvedValue(true),
    listSweepable: vi.fn(),
    markExpiredInTx: vi.fn(),
    listStuckProcessing: vi.fn(),
    reclaimStuckInTx: vi.fn(),
  };
}

function stubBlob(found = true): PrivateBlobPort {
  return {
    putPrivate: vi.fn(),
    delete: vi.fn(),
    download: vi
      .fn()
      .mockResolvedValue(
        found
          ? { stream: new ReadableStream<Uint8Array>(), contentType: 'application/json' }
          : null,
      ),
  };
}

const audit = () => ({ recordInTx: vi.fn(), record: vi.fn() });
const clock = { now: () => new Date() };

const staff = (role: 'admin' | 'manager'): DownloadExportMeta => ({
  actorUserId: 'u-1',
  actorRole: role,
  actorMemberId: null,
  requestId: 'req-1',
});
const member = (memberId: string): DownloadExportMeta => ({
  actorUserId: 'u-1',
  actorRole: 'member',
  actorMemberId: memberId,
  requestId: 'req-1',
});

function downloadDeps(repo: ExportJobRepo, blob: PrivateBlobPort) {
  return { exportJobRepo: repo, blob, audit: audit(), clock };
}

describe('downloadExport — authz matrix (T073a)', () => {
  it('404 when the job is unknown (or cross-tenant → RLS null)', async () => {
    const r = await downloadExport({ jobId: JOB_ID, token: 't' }, staff('admin'), ctx, downloadDeps(stubRepo(null), stubBlob()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');
  });

  it('403: a member cannot download a directory artefact (staff-only)', async () => {
    const r = await downloadExport({ jobId: JOB_ID, token: 't' }, member('m-1'), ctx, downloadDeps(stubRepo(job()), stubBlob()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });

  it("403: a member cannot download another member's GDPR archive", async () => {
    const repo = stubRepo(job({ kind: 'gdpr_member_archive', subjectMemberId: 'm-1' }));
    const r = await downloadExport({ jobId: JOB_ID, token: 't' }, member('m-2'), ctx, downloadDeps(repo, stubBlob()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });

  it('403: a manager cannot download a subject (GDPR) archive', async () => {
    const repo = stubRepo(job({ kind: 'gdpr_member_archive', subjectMemberId: 'm-1' }));
    const r = await downloadExport({ jobId: JOB_ID, token: 't' }, staff('manager'), ctx, downloadDeps(repo, stubBlob()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });

  it('409 when the job is not yet ready', async () => {
    const r = await downloadExport({ jobId: JOB_ID, token: 't' }, staff('admin'), ctx, downloadDeps(stubRepo(job({ status: 'processing' })), stubBlob()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_ready');
  });

  it('410 when the job has expired (status) or is past expires_at', async () => {
    const expiredStatus = await downloadExport({ jobId: JOB_ID, token: 't' }, staff('admin'), ctx, downloadDeps(stubRepo(job({ status: 'expired' })), stubBlob()));
    expect(expiredStatus.ok).toBe(false);
    if (!expiredStatus.ok) expect(expiredStatus.error).toBe('expired');

    const pastTtl = await downloadExport({ jobId: JOB_ID, token: 't' }, staff('admin'), ctx, downloadDeps(stubRepo(job({ expiresAt: new Date(Date.now() - 1000) })), stubBlob()));
    expect(pastTtl.ok).toBe(false);
    if (!pastTtl.ok) expect(pastTtl.error).toBe('expired');
  });

  it('invalid_token when no token has been minted (hash null) or the token is wrong', async () => {
    const token = mintDownloadToken();
    const noHash = await downloadExport({ jobId: JOB_ID, token }, staff('admin'), ctx, downloadDeps(stubRepo(job({ downloadTokenHash: null })), stubBlob()));
    expect(noHash.ok).toBe(false);
    if (!noHash.ok) expect(noHash.error).toBe('invalid_token');

    const wrongToken = await downloadExport({ jobId: JOB_ID, token: 'wrong' }, staff('admin'), ctx, downloadDeps(stubRepo(job({ downloadTokenHash: hashDownloadToken(JOB_ID, token) })), stubBlob()));
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) expect(wrongToken.error).toBe('invalid_token');
  });

  it('410 when the artefact has been swept from Blob', async () => {
    const token = mintDownloadToken();
    const repo = stubRepo(job({ downloadTokenHash: hashDownloadToken(JOB_ID, token) }));
    const r = await downloadExport({ jobId: JOB_ID, token }, staff('admin'), ctx, downloadDeps(repo, stubBlob(false)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('expired');
  });

  it('success: valid token → streams + consumes the token (single-use) + audits', async () => {
    const token = mintDownloadToken();
    const repo = stubRepo(job({ downloadTokenHash: hashDownloadToken(JOB_ID, token) }));
    const a = audit();
    const r = await downloadExport(
      { jobId: JOB_ID, token },
      staff('admin'),
      ctx,
      { exportJobRepo: repo, blob: stubBlob(), audit: a, clock },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filename).toBe('directory.json');
    expect(repo.consumeForDownloadInTx).toHaveBeenCalledOnce(); // single-use
    expect(a.recordInTx).toHaveBeenCalledOnce(); // data_export_downloaded
  });

  it('success: the subject member may download their own GDPR archive', async () => {
    const token = mintDownloadToken();
    const repo = stubRepo(
      job({ kind: 'gdpr_member_archive', subjectMemberId: 'm-1', downloadTokenHash: hashDownloadToken(JOB_ID, token) }),
    );
    const r = await downloadExport({ jobId: JOB_ID, token }, member('m-1'), ctx, downloadDeps(repo, stubBlob()));
    expect(r.ok).toBe(true);
  });
});

describe('prepareExportDownload — mint authz (T073a)', () => {
  it('403: a member cannot mint a directory-artefact link', async () => {
    const r = await prepareExportDownload({ jobId: JOB_ID }, member('m-1'), ctx, { exportJobRepo: stubRepo(job()), clock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });

  it('404 / 409 / 410 mirror the download guards', async () => {
    const notFound = await prepareExportDownload({ jobId: JOB_ID }, staff('admin'), ctx, { exportJobRepo: stubRepo(null), clock });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error).toBe('not_found');

    const notReady = await prepareExportDownload({ jobId: JOB_ID }, staff('admin'), ctx, { exportJobRepo: stubRepo(job({ status: 'requested' })), clock });
    expect(notReady.ok).toBe(false);
    if (!notReady.ok) expect(notReady.error).toBe('not_ready');

    const expired = await prepareExportDownload({ jobId: JOB_ID }, staff('admin'), ctx, { exportJobRepo: stubRepo(job({ status: 'expired' })), clock });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error).toBe('expired');
  });

  it('success: mints a token + stores its hash', async () => {
    const repo = stubRepo(job());
    const r = await prepareExportDownload({ jobId: JOB_ID }, staff('admin'), ctx, { exportJobRepo: repo, clock });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token.length).toBeGreaterThanOrEqual(24);
    expect(repo.setDownloadTokenInTx).toHaveBeenCalledOnce();
  });
});
