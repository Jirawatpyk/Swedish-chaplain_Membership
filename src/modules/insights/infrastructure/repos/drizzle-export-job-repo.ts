/**
 * F9 US5/US6 `ExportJobRepo` Drizzle adapter (T070-infra).
 *
 * Binds the tenant at construction; threads the caller's `tx` from
 * `runInTenant` for writes (CLAUDE.md RLS gotcha). All transitions are guarded
 * (`WHERE id = $id AND status = $from`) so a concurrent writer cannot corrupt
 * the row — the guard returns 0 rows and the caller learns the transition lost.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { exportJobs, type ExportJobRow } from '../db/schema-insights';
import type {
  CreateExportJobInput,
  ExportJobRecord,
  ExportJobRepo,
  SweepableJob,
} from '../../application/ports/export-job-repo';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: ExportJobRow): ExportJobRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    subjectMemberId: row.subjectMemberId,
    requestedBy: row.requestedBy,
    requestedForPeriod: row.requestedForPeriod,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    blobKey: row.blobKey,
    downloadTokenHash: row.downloadTokenHash,
    expiresAt: row.expiresAt,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeDrizzleExportJobRepo(tenantId: string): ExportJobRepo {
  return {
    async createOrGetInTx(tx: TenantTx, input: CreateExportJobInput) {
      const inserted = await tx
        .insert(exportJobs)
        .values({
          tenantId,
          kind: input.kind,
          subjectMemberId: input.subjectMemberId,
          requestedBy: input.requestedBy,
          requestedForPeriod: input.requestedForPeriod,
          idempotencyKey: input.idempotencyKey,
          status: 'requested',
        })
        .onConflictDoNothing({
          target: [exportJobs.tenantId, exportJobs.idempotencyKey],
        })
        .returning();
      const insertedRow = inserted[0];
      if (insertedRow !== undefined) {
        return { job: toRecord(insertedRow), created: true };
      }
      // Conflict → an existing job has the same idempotency key (Principle VIII).
      const existing = await tx
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      // The conflict guarantees a row exists; `!` is safe but we guard anyway.
      const row = existing[0]!;
      return { job: toRecord(row), created: false };
    },

    async acquireJobLockInTx(tx: TenantTx, jobId: string): Promise<void> {
      // Per-(tenant,job) advisory lock — namespace disjoint from F4/F5/F7.
      // Auto-released at tx end. tenantId + jobId are app-controlled (no injection).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('insights:export:' || ${tenantId} || ':' || ${jobId}, 0))`,
      );
    },

    async findById(ctx: TenantContext, jobId: string) {
      if (!UUID_RE.test(jobId)) return null;
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.id, jobId))
          .limit(1);
        return rows[0] === undefined ? null : toRecord(rows[0]);
      });
    },

    async findByIdInTx(tx: TenantTx, jobId: string) {
      if (!UUID_RE.test(jobId)) return null;
      const rows = await tx
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.id, jobId))
        .limit(1);
      return rows[0] === undefined ? null : toRecord(rows[0]);
    },

    async listRequestedIds(ctx: TenantContext, limit: number) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(eq(exportJobs.status, 'requested'))
          .orderBy(exportJobs.createdAt)
          .limit(limit);
        return rows.map((r) => r.id);
      });
    },

    async claimInTx(tx: TenantTx, jobId: string) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'requested')))
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async markReadyInTx(tx, jobId, patch) {
      const updated = await tx
        .update(exportJobs)
        .set({
          status: 'ready',
          blobKey: patch.blobKey,
          expiresAt: patch.expiresAt,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'processing')))
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async markFailedInTx(tx, jobId, errorCode) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'failed', errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['requested', 'processing']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async setDownloadTokenInTx(tx, jobId, tokenHash) {
      const updated = await tx
        .update(exportJobs)
        .set({ downloadTokenHash: tokenHash, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async consumeForDownloadInTx(tx, jobId) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'delivered', downloadTokenHash: null, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async listSweepable(ctx: TenantContext): Promise<readonly SweepableJob[]> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ id: exportJobs.id, blobKey: exportJobs.blobKey })
          .from(exportJobs)
          .where(
            and(
              inArray(exportJobs.status, ['ready', 'delivered']),
              lt(exportJobs.expiresAt, new Date()),
            ),
          );
        return rows.map((r) => ({ jobId: r.id, blobKey: r.blobKey }));
      });
    },

    async markExpiredInTx(tx, jobId) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'expired', downloadTokenHash: null, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async listStuckProcessing(ctx: TenantContext, timeoutMs: number) {
      const cutoff = new Date(Date.now() - timeoutMs);
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.status, 'processing'),
              lt(exportJobs.updatedAt, cutoff),
            ),
          );
        return rows.map((r) => r.id);
      });
    },

    async reclaimStuckInTx(tx, jobId, errorCode) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'failed', errorCode, updatedAt: new Date() })
        .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'processing')))
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },
  };
}
