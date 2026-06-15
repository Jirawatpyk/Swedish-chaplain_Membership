/**
 * F9 US5/US6 `ExportJobRepo` Drizzle adapter (T070-infra).
 *
 * Binds the tenant at construction; threads the caller's `tx` from
 * `runInTenant` for writes (CLAUDE.md RLS gotcha). All transitions are guarded
 * (`WHERE id = $id AND status = $from`) so a concurrent writer cannot corrupt
 * the row — the guard returns 0 rows and the caller learns the transition lost.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { isLocale } from '@/i18n/config';
import type { TenantContext } from '@/modules/tenants';
import { exportJobs, type ExportJobRow } from '../db/schema-insights';
import type {
  CreateExportJobInput,
  ExportJobRecord,
  ExportJobRepo,
  StuckJob,
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
    // The text column is app-controlled (only `requestDataExport` writes it, with
    // a validated Locale), but re-validate at the read boundary rather than trust
    // a non-local invariant: a manual backfill / migration default could seed a
    // non-Locale string. An invalid value narrows to null (→ tenant default).
    requesterLocale:
      row.requesterLocale !== null && isLocale(row.requesterLocale)
        ? row.requesterLocale
        : null,
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
          requesterLocale: input.requesterLocale,
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
          .where(and(eq(exportJobs.tenantId, tenantId), eq(exportJobs.id, jobId)))
          .limit(1);
        return rows[0] === undefined ? null : toRecord(rows[0]);
      });
    },

    async findByIdInTx(tx: TenantTx, jobId: string) {
      if (!UUID_RE.test(jobId)) return null;
      const rows = await tx
        .select()
        .from(exportJobs)
        .where(and(eq(exportJobs.tenantId, tenantId), eq(exportJobs.id, jobId)))
        .limit(1);
      return rows[0] === undefined ? null : toRecord(rows[0]);
    },

    async listRecent(ctx, kinds, limit) {
      if (kinds.length === 0) return [];
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.tenantId, tenantId),
              inArray(exportJobs.kind, [...kinds]),
            ),
          )
          .orderBy(desc(exportJobs.createdAt))
          .limit(limit);
        return rows.map(toRecord);
      });
    },

    async listRecentForSubject(ctx, subjectMemberId, kind, limit) {
      if (!UUID_RE.test(subjectMemberId)) return [];
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.tenantId, tenantId),
              eq(exportJobs.subjectMemberId, subjectMemberId),
              eq(exportJobs.kind, kind),
            ),
          )
          .orderBy(desc(exportJobs.createdAt))
          .limit(limit);
        return rows.map(toRecord);
      });
    },

    async listRequestedIds(ctx: TenantContext, limit: number) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.tenantId, tenantId),
              eq(exportJobs.status, 'requested'),
            ),
          )
          .orderBy(exportJobs.createdAt)
          .limit(limit);
        return rows.map((r) => r.id);
      });
    },

    async claimInTx(tx: TenantTx, jobId: string) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            eq(exportJobs.status, 'requested'),
          ),
        )
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
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            eq(exportJobs.status, 'processing'),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async markFailedInTx(tx, jobId, errorCode) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'failed', errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['requested', 'processing']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async touchProcessingInTx(tx, jobId) {
      // Heartbeat: bump updated_at on a still-`processing` row so the stuck
      // sweep (which keys on updated_at) does not reclaim a healthy in-flight
      // build. Guarded — once the job leaves `processing` this matches 0 rows.
      const updated = await tx
        .update(exportJobs)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            eq(exportJobs.status, 'processing'),
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
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
            // P2 Wave-0 — make the mint atomic w.r.t. expiry. prepareExportDownload
            // checks isExpired on a pre-tx snapshot; without this guard a token
            // could be minted for a job that crossed expiresAt in the check→mint
            // window (status still ready, pre-sweep). Downstream downloadExport
            // re-checks expiry so no expired DATA leaks, but a 0-row update here
            // surfaces the race as `not_ready` instead of issuing a dead token.
            or(isNull(exportJobs.expiresAt), gt(exportJobs.expiresAt, new Date())),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async consumeForDownloadInTx(tx, jobId) {
      // Atomic single-use consume. The `downloadTokenHash IS NOT NULL` guard
      // makes this an optimistic-lock check-and-consume: under two concurrent
      // downloads of the SAME minted token, Postgres row-locking serialises the
      // UPDATEs — the first nulls the hash and returns 1 row; the second
      // re-evaluates the WHERE against the committed row, sees a null hash, and
      // returns 0. The use-case treats `false` as `invalid_token` and does NOT
      // stream/audit, closing the read-verify-vs-consume TOCTOU on the GDPR PII
      // token (double-click / link-prefetch). A re-download still works because
      // prepare re-mints a fresh hash. (code-review max F9 — finding #11)
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'delivered', downloadTokenHash: null, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
            isNotNull(exportJobs.downloadTokenHash),
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
              eq(exportJobs.tenantId, tenantId),
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
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            inArray(exportJobs.status, ['ready', 'delivered']),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },

    async purgeRetiredInTx(tx, olderThan): Promise<number> {
      // P2 Wave-0 — hard-delete terminal rows past the grace window so the
      // pseudonymous PII (subject_member_id, requested_by) is not retained
      // indefinitely. Tenant-scoped (RLS + explicit predicate, defence-in-depth).
      const deleted = await tx
        .delete(exportJobs)
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            inArray(exportJobs.status, ['expired', 'failed']),
            lt(exportJobs.updatedAt, olderThan),
          ),
        )
        .returning({ id: exportJobs.id });
      return deleted.length;
    },

    async listStuckProcessing(
      ctx: TenantContext,
      timeoutMs: number,
    ): Promise<readonly StuckJob[]> {
      const cutoff = new Date(Date.now() - timeoutMs);
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ id: exportJobs.id, kind: exportJobs.kind })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.tenantId, tenantId),
              eq(exportJobs.status, 'processing'),
              lt(exportJobs.updatedAt, cutoff),
            ),
          );
        return rows.map((r) => ({ jobId: r.id, kind: r.kind }));
      });
    },

    async reclaimStuckInTx(tx, jobId, errorCode) {
      const updated = await tx
        .update(exportJobs)
        .set({ status: 'failed', errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(exportJobs.tenantId, tenantId),
            eq(exportJobs.id, jobId),
            eq(exportJobs.status, 'processing'),
          ),
        )
        .returning({ id: exportJobs.id });
      return updated.length > 0;
    },
  };
}
