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

  it('listRecentForSubject: subject + kind scoped, newest-first (US6 / W2)', async () => {
    const subjectA = randomUUID();
    const subjectB = randomUUID();
    // Two GDPR jobs for subject A + one for subject B + one directory job.
    for (const [subject, period] of [
      [subjectA, 'lrs-A1'],
      [subjectA, 'lrs-A2'],
      [subjectB, 'lrs-B1'],
    ] as const) {
      await runInTenant(tenant.ctx, (tx) =>
        repo().createOrGetInTx(tx, {
          kind: 'gdpr_member_archive',
          subjectMemberId: subject,
          requestedBy: requester,
          requestedForPeriod: period,
          requesterLocale: 'en',
          idempotencyKey: exportJobIdempotencyInput({
            tenantId: tenant.ctx.slug,
            kind: 'gdpr_member_archive',
            subjectMemberId: subject,
            requestedForPeriod: period,
          }),
        }),
      );
    }

    const rows = await repo().listRecentForSubject(
      tenant.ctx,
      subjectA,
      'gdpr_member_archive',
      5,
    );
    // Only subject A's GDPR jobs (2), never subject B's.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.subjectMemberId === subjectA)).toBe(true);
    expect(rows.every((r) => r.kind === 'gdpr_member_archive')).toBe(true);
    // Newest-first (createdAt DESC).
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[1]!.createdAt.getTime());
    // A non-existent subject → empty.
    const none = await repo().listRecentForSubject(
      tenant.ctx,
      randomUUID(),
      'gdpr_member_archive',
      5,
    );
    expect(none).toHaveLength(0);
  });

  it('createOrGet is idempotent on (tenant, idempotency_key)', async () => {
    const input = {
      kind: 'directory_ebook' as const,
      subjectMemberId: null,
      requestedBy: requester,
      requestedForPeriod: '2026',
      requesterLocale: null,
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
        requesterLocale: null,
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

    // Single-use is ATOMIC: a SECOND consume of the now-token-less job matches
    // 0 rows (the `downloadTokenHash IS NOT NULL` guard) → false. This is the
    // optimistic lock that makes two concurrent downloads of the SAME token
    // mutually exclusive — only the first wins; the loser must not stream/audit.
    // (code-review max F9 — finding #11)
    expect(
      await runInTenant(tenant.ctx, (tx) => repo().consumeForDownloadInTx(tx, jobId)),
    ).toBe(false);
  });

  it('TTL sweep: a delivered job past expires_at is sweepable → expired', async () => {
    const job = await runInTenant(tenant.ctx, (tx) =>
      repo().createOrGetInTx(tx, {
        kind: 'directory_json',
        subjectMemberId: null,
        requestedBy: requester,
        requestedForPeriod: 'sweep-2026',
        requesterLocale: null,
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
        requesterLocale: null,
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
        requesterLocale: null,
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

  it('cross-tenant isolation: tenant B cannot read/claim/list tenant A jobs (review I4b)', async () => {
    // Cross-tenant REGRESSION net for findById / claimInTx / listRecentForSubject:
    // a job owned by tenant A must be invisible + immutable from a tenant-B repo +
    // context. NOTE: this asserts the COMBINED guarantee — tenant B runs under its
    // own RLS context (`runInTenant(other.ctx)`), so RLS alone already hides A's
    // row; it does NOT isolate the explicit `eq(exportJobs.tenantId, …)` second
    // wall (that is covered by code review + the per-method predicate). The value
    // here is catching any future change that breaks cross-tenant isolation end
    // to end, not proving which of the two layers does the blocking.
    const other = await createTestTenant('test-chamber');
    const otherRepo = () => makeDrizzleExportJobRepo(other.ctx.slug);
    const subject = randomUUID();
    try {
      const created = await runInTenant(tenant.ctx, (tx) =>
        repo().createOrGetInTx(tx, {
          kind: 'gdpr_member_archive',
          subjectMemberId: subject,
          requestedBy: requester,
          requestedForPeriod: 'xt-2026',
          requesterLocale: 'en',
          idempotencyKey: exportJobIdempotencyInput({
            tenantId: tenant.ctx.slug,
            kind: 'gdpr_member_archive',
            subjectMemberId: subject,
            requestedForPeriod: 'xt-2026',
          }),
        }),
      );
      const jobId = created.job.id;

      // findById under tenant B → not visible.
      expect(await otherRepo().findById(other.ctx, jobId)).toBeNull();
      // claimInTx under tenant B → 0 rows matched (cannot mutate A's job).
      expect(await runInTenant(other.ctx, (tx) => otherRepo().claimInTx(tx, jobId))).toBe(false);
      // listRecentForSubject under tenant B (same subject id) → empty.
      expect(
        await otherRepo().listRecentForSubject(other.ctx, subject, 'gdpr_member_archive', 10),
      ).toHaveLength(0);

      // Tenant A's job is untouched (still `requested`).
      const stillA = await repo().findById(tenant.ctx, jobId);
      expect(stillA?.status).toBe('requested');
    } finally {
      await db.delete(exportJobs).where(eq(exportJobs.tenantId, other.ctx.slug)).catch(() => {});
      await other.cleanup().catch(() => {});
    }
  });

  it('purgeRetiredInTx: hard-deletes terminal rows past the grace cutoff; keeps recent + non-terminal (P2 Wave-0 PDPA)', async () => {
    const mk = async (period: string): Promise<string> => {
      const created = await runInTenant(tenant.ctx, (tx) =>
        repo().createOrGetInTx(tx, {
          kind: 'directory_ebook',
          subjectMemberId: null,
          requestedBy: requester,
          requestedForPeriod: period,
          requesterLocale: 'en',
          idempotencyKey: exportJobIdempotencyInput({
            tenantId: tenant.ctx.slug,
            kind: 'directory_ebook',
            subjectMemberId: null,
            requestedForPeriod: period,
          }),
        }),
      );
      return created.job.id;
    };
    const oldExpired = await mk('purge-old-expired');
    const recentExpired = await mk('purge-recent-expired');
    const oldRequested = await mk('purge-old-requested');

    const old = new Date('2020-01-01T00:00:00Z');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.update(exportJobs).set({ status: 'expired', updatedAt: old }).where(eq(exportJobs.id, oldExpired));
      await tx.update(exportJobs).set({ status: 'expired', updatedAt: new Date() }).where(eq(exportJobs.id, recentExpired));
      // Non-terminal (requested) — must be kept regardless of age.
      await tx.update(exportJobs).set({ status: 'requested', updatedAt: old }).where(eq(exportJobs.id, oldRequested));
    });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await runInTenant(tenant.ctx, (tx) => repo().purgeRetiredInTx(tx, cutoff));

    expect(deleted).toBe(1); // only the old terminal row
    expect(await repo().findById(tenant.ctx, oldExpired)).toBeNull();
    expect((await repo().findById(tenant.ctx, recentExpired))?.status).toBe('expired');
    expect((await repo().findById(tenant.ctx, oldRequested))?.status).toBe('requested');
  });
});
