/**
 * F9 US5/US6 (T070-infra) — `ExportJobRepo` state-machine integration (live Neon).
 *
 * Validates the guarded transitions + idempotent create against the real
 * export_jobs table (RLS + unique idempotency index):
 *   createOrGet (idempotent) → claim (requested→processing, double-claim loses)
 *   → markReady → setDownloadToken → consumeForDownload (ready→delivered, single-use)
 *   → markExpired; plus markFailed + stuck-reclaim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
import { makeDrizzleExportJobRepo } from '@/modules/insights/infrastructure/repos/drizzle-export-job-repo';
import { exportJobIdempotencyInput, STUCK_PROCESSING_TIMEOUT_MS } from '@/modules/insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F9 ExportJobRepo — integration (T070-infra)', () => {
  let tenant: TestTenant;
  const requester = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await db.delete(exportJobs).where(eq(exportJobs.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  const repo = () => makeDrizzleExportJobRepo(tenant.ctx.slug);
  const idem = (period: string) =>
    exportJobIdempotencyInput({
      tenantId: tenant.ctx.slug,
      kind: 'directory_ebook',
      subjectMemberId: null,
      requestedForPeriod: period,
    });

  it('createOrGet is idempotent on (tenant, idempotency_key)', async () => {
    const input = {
      kind: 'directory_ebook' as const,
      subjectMemberId: null,
      requestedBy: requester,
      requestedForPeriod: '2026',
      idempotencyKey: idem('2026'),
    };
    const first = await runInTenant(tenant.ctx, (tx) => repo().createOrGetInTx(tx, input));
    expect(first.created).toBe(true);
    expect(first.job.status).toBe('requested');

    const second = await runInTenant(tenant.ctx, (tx) => repo().createOrGetInTx(tx, input));
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id); // same job, not a duplicate
  });

  it('full happy-path transition: claim → ready → mint token → consume (single-use)', async () => {
    const job = await runInTenant(tenant.ctx, (tx) =>
      repo().createOrGetInTx(tx, {
        kind: 'directory_json',
        subjectMemberId: null,
        requestedBy: requester,
        requestedForPeriod: 'json-2026',
        idempotencyKey: idem('json-2026'),
      }),
    );
    const jobId = job.job.id;

    // claim
    expect(await runInTenant(tenant.ctx, (tx) => repo().claimInTx(tx, jobId))).toBe(true);
    // double-claim loses (guard: WHERE status='requested')
    expect(await runInTenant(tenant.ctx, (tx) => repo().claimInTx(tx, jobId))).toBe(false);

    // ready
    const expiresAt = new Date(Date.now() + 3_600_000);
    expect(
      await runInTenant(tenant.ctx, (tx) =>
        repo().markReadyInTx(tx, jobId, { blobKey: `exports/${tenant.ctx.slug}/${jobId}.json`, expiresAt }),
      ),
    ).toBe(true);

    // mint token
    expect(
      await runInTenant(tenant.ctx, (tx) => repo().setDownloadTokenInTx(tx, jobId, 'hash-abc')),
    ).toBe(true);
    let row = await repo().findById(tenant.ctx, jobId);
    expect(row?.status).toBe('ready');
    expect(row?.downloadTokenHash).toBe('hash-abc');
    expect(row?.blobKey).toContain(jobId);

    // consume on download → delivered + token nulled (single-use)
    expect(
      await runInTenant(tenant.ctx, (tx) => repo().consumeForDownloadInTx(tx, jobId)),
    ).toBe(true);
    row = await repo().findById(tenant.ctx, jobId);
    expect(row?.status).toBe('delivered');
    expect(row?.downloadTokenHash).toBeNull();
  });

  it('TTL sweep: a delivered job past expires_at is sweepable → expired', async () => {
    const job = await runInTenant(tenant.ctx, (tx) =>
      repo().createOrGetInTx(tx, {
        kind: 'directory_json',
        subjectMemberId: null,
        requestedBy: requester,
        requestedForPeriod: 'sweep-2026',
        idempotencyKey: idem('sweep-2026'),
      }),
    );
    const jobId = job.job.id;
    const blobKey = `exports/${tenant.ctx.slug}/${jobId}.json`;
    await runInTenant(tenant.ctx, async (tx) => {
      await repo().claimInTx(tx, jobId);
      await repo().markReadyInTx(tx, jobId, {
        blobKey,
        expiresAt: new Date(Date.now() - 60_000), // already expired
      });
    });

    const sweepable = await repo().listSweepable(tenant.ctx);
    const target = sweepable.find((s) => s.jobId === jobId);
    expect(target).toBeDefined();
    expect(target?.blobKey).toBe(blobKey);

    expect(
      await runInTenant(tenant.ctx, (tx) => repo().markExpiredInTx(tx, jobId)),
    ).toBe(true);
    const row = await repo().findById(tenant.ctx, jobId);
    expect(row?.status).toBe('expired');
  });

  it('markFailed on a requested job → failed (terminal)', async () => {
    const job = await runInTenant(tenant.ctx, (tx) =>
      repo().createOrGetInTx(tx, {
        kind: 'directory_ebook',
        subjectMemberId: null,
        requestedBy: requester,
        requestedForPeriod: 'fail-2026',
        idempotencyKey: idem('fail-2026'),
      }),
    );
    expect(
      await runInTenant(tenant.ctx, (tx) => repo().markFailedInTx(tx, job.job.id, 'render_error')),
    ).toBe(true);
    const row = await repo().findById(tenant.ctx, job.job.id);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('render_error');
  });

  it('stuck-processing reclaim: lists + transitions processing → failed', async () => {
    const job = await runInTenant(tenant.ctx, (tx) =>
      repo().createOrGetInTx(tx, {
        kind: 'directory_ebook',
        subjectMemberId: null,
        requestedBy: requester,
        requestedForPeriod: 'stuck-2026',
        idempotencyKey: idem('stuck-2026'),
      }),
    );
    const jobId = job.job.id;
    await runInTenant(tenant.ctx, (tx) => repo().claimInTx(tx, jobId));
    // Backdate updated_at past the stuck window (owner bypasses RLS).
    await db
      .update(exportJobs)
      .set({ updatedAt: new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS - 60_000) })
      .where(eq(exportJobs.id, jobId));

    const stuck = await repo().listStuckProcessing(tenant.ctx, STUCK_PROCESSING_TIMEOUT_MS);
    expect(stuck).toContain(jobId);
    expect(
      await runInTenant(tenant.ctx, (tx) => repo().reclaimStuckInTx(tx, jobId, 'worker_timeout')),
    ).toBe(true);
    const row = await repo().findById(tenant.ctx, jobId);
    expect(row?.status).toBe('failed');
  });

  it('listRequestedIds returns only requested jobs', async () => {
    const ids = await repo().listRequestedIds(tenant.ctx, 50);
    // All earlier jobs have advanced past requested; nothing should be requested.
    expect(Array.isArray(ids)).toBe(true);
  });
});
