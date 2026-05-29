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

  /** Guarded `requested|processing → failed` (records the error code). */
  markFailedInTx(tx: TenantTx, jobId: string, errorCode: string): Promise<boolean>;

  /** Mint: set the single-use download-token hash (only when ready|delivered). */
  setDownloadTokenInTx(
    tx: TenantTx,
    jobId: string,
    tokenHash: string,
  ): Promise<boolean>;

  /**
   * Consume on download: `ready → delivered` (first download) and null the
   * token hash (single-use). A re-download of an already-`delivered` job stays
   * delivered; the proxy requires a freshly-minted token each time.
   */
  consumeForDownloadInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /** ready|delivered jobs past their TTL — for the cron blob-delete + expire. */
  listSweepable(ctx: TenantContext): Promise<readonly SweepableJob[]>;
  markExpiredInTx(tx: TenantTx, jobId: string): Promise<boolean>;

  /** `processing` jobs whose claim is older than the timeout (crashed worker). */
  listStuckProcessing(
    ctx: TenantContext,
    timeoutMs: number,
  ): Promise<readonly string[]>;
  reclaimStuckInTx(tx: TenantTx, jobId: string, errorCode: string): Promise<boolean>;
}
