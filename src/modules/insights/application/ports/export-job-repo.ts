/**
 * F9 US5/US6 `ExportJobRepo` Application port (T070-infra).
 *
 * CRUD + state-machine transitions over the insights `export_jobs` table. The
 * Domain `export-job.ts` owns the legal-transition rules; this repo issues
 * **guarded** writes (`WHERE id = $id AND status = $from`) so a concurrent
 * transition cannot corrupt the row (the guard is the optimistic lock). The
 * worker additionally serialises per-(tenant,job) with a Postgres advisory lock.
 *
 * `updated_at` doubles as the claim timestamp: a `requested → processing`
 * transition stamps `updated_at = now()`, and the stuck-reclaim sweep treats a
 * `processing` row whose `updated_at` is older than the timeout as crashed
 * (data-model § 4 / critique E2). No extra claim column.
 *
 * `tx: TenantTx` mirrors the other insights repos; standalone reads self-scope
 * via `ctx`. Pure interface — no ORM import (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { Locale } from '@/i18n/config';
import type { ExportKind, ExportStatus } from '../../domain/export-job';

export interface ExportJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: ExportKind;
  readonly subjectMemberId: string | null;
  readonly requestedBy: string;
  readonly requestedForPeriod: string | null;
  /** FR-029 — requester's locale for the GDPR README (null for non-GDPR kinds). */
  readonly requesterLocale: Locale | null;
  readonly status: ExportStatus;
  readonly idempotencyKey: string;
  readonly blobKey: string | null;
  readonly downloadTokenHash: string | null;
  readonly expiresAt: Date | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateExportJobInput {
  readonly kind: ExportKind;
  readonly subjectMemberId: string | null;
  readonly requestedBy: string;
  readonly requestedForPeriod: string | null;
  /** FR-029 — requester locale for the GDPR README (null for non-GDPR kinds). */
  readonly requesterLocale: Locale | null;
  readonly idempotencyKey: string;
}

export interface SweepableJob {
  readonly jobId: string;
  readonly blobKey: string | null;
}

/**
 * A stuck `processing` job surfaced by the reclaim sweep. Carries the `kind` so
 * the cron can emit the correct terminal audit event when it reclaims the job to
 * `failed` (a `gdpr_member_archive` reclaim must emit `data_export_failed` —
 * FR-037 no silent failure; the directory kinds have no failed event).
 */
export interface StuckJob {
  readonly jobId: string;
  readonly kind: ExportKind;
  /** Subject member — so the reclaim's `data_export_failed` row scopes into the
   *  member's GDPR audit subset (Art. 15). Null for non-GDPR/subject-less jobs. */
  readonly subjectMemberId: string | null;
}

export interface ExportJobRepo {
  /**
   * Idempotent create: returns the existing job for a duplicate
   * `(tenant_id, idempotency_key)` (Principle VIII) instead of a second
   * artefact; `created` distinguishes the two for audit.
   */
  createOrGetInTx(
    tx: TenantTx,
    input: CreateExportJobInput,
  ): Promise<{ readonly job: ExportJobRecord; readonly created: boolean }>;

  /**
   * Per-(tenant,job) transaction advisory lock so two concurrent workers never
   * process the same job. Auto-released at tx end. Namespace `insights:export:`
   * is disjoint from the F4 `invoicing:` / F5 `payments:` / F7 `broadcasts:` locks.
   */
  acquireJobLockInTx(tx: TenantTx, jobId: string): Promise<void>;

  /** Standalone read (download proxy + status poll). Self-scoped via ctx/RLS. */
  findById(ctx: TenantContext, jobId: string): Promise<ExportJobRecord | null>;
  findByIdInTx(tx: TenantTx, jobId: string): Promise<ExportJobRecord | null>;

  /** Recent jobs of the given kinds, newest first — for the directory page list. */
  listRecent(
    ctx: TenantContext,
    kinds: readonly ExportKind[],
    limit: number,
  ): Promise<readonly ExportJobRecord[]>;

  /**
   * Recent jobs of one kind for a single subject member, newest first — for the
   * member's GDPR data-export portal page (US6). Tenant + subject scoped.
   */
  listRecentForSubject(
    ctx: TenantContext,
    subjectMemberId: string,
    kind: ExportKind,
    limit: number,
  ): Promise<readonly ExportJobRecord[]>;

  /** Ids of `requested` jobs for the worker to claim (oldest first). */
  listRequestedIds(ctx: TenantContext, limit: number): Promise<readonly string[]>;

  /** Guarded `requested → processing` claim (stamps updated_at). */
  claimInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /** Guarded `processing → ready` (sets blob key + TTL). */
  markReadyInTx(
    tx: TenantTx,
    jobId: string,
    patch: { readonly blobKey: string; readonly expiresAt: Date },
  ): Promise<boolean>;

  /**
   * Heartbeat: refresh a still-`processing` job's `updated_at` so a concurrent
   * cron tick's stuck-reclaim does not false-fail a healthy in-flight build.
   * Guarded (`WHERE status = 'processing'`) — a no-op (returns false) once the
   * job has left `processing` (already ready/reclaimed). Never advances state.
   */
  touchProcessingInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /** Guarded `requested|processing → failed` (records the error code). */
  markFailedInTx(tx: TenantTx, jobId: string, errorCode: string): Promise<boolean>;

  /** Mint: set the single-use download-token hash (only when ready|delivered). */
  setDownloadTokenInTx(
    tx: TenantTx,
    jobId: string,
    tokenHash: string,
  ): Promise<boolean>;

  /**
   * Consume on download: `ready → delivered` and null the token hash
   * (single-use). Implemented as an ATOMIC guarded check-and-consume (the
   * write only matches a row whose `download_token_hash IS NOT NULL`), so two
   * concurrent downloads of the same token serialise on the row lock and only
   * the first returns `true` — the caller MUST treat `false` as a spent token
   * and not stream/audit (TOCTOU defence, F9 #11). A re-download requires a
   * freshly-minted token each time (the mint re-sets the hash).
   */
  consumeForDownloadInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /** ready|delivered jobs past their TTL — for the cron blob-delete + expire. */
  listSweepable(ctx: TenantContext): Promise<readonly SweepableJob[]>;
  markExpiredInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /**
   * `processing` jobs whose claim is older than the timeout (crashed worker).
   * Returns each job's `kind` (not just its id) so the cron can emit the correct
   * terminal audit event on reclaim (mirrors `listSweepable`'s shape).
   */
  listStuckProcessing(
    ctx: TenantContext,
    timeoutMs: number,
  ): Promise<readonly StuckJob[]>;
  reclaimStuckInTx(tx: TenantTx, jobId: string, errorCode: string): Promise<boolean>;

  /**
   * P2 Wave-0 (PDPA data-minimization) — hard-delete terminal `expired`/`failed`
   * job rows whose `updatedAt` is older than `olderThan`. The TTL sweep already
   * removed the private-Blob artefact (the real archive PII), but the job ROW
   * still carries pseudonymous personal data (`subjectMemberId`, `requestedBy`)
   * indefinitely. A grace window keeps recent terminal rows visible (status UI /
   * support), then they are purged — the `data_export_expired` audit row (5y) is
   * the durable lifecycle record. Returns the number of rows deleted.
   */
  purgeRetiredInTx(tx: TenantTx, olderThan: Date): Promise<number>;
}
