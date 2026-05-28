/**
 * F9 US5/US6 export download use-cases (T073 / research R6).
 *
 *   - `prepareExportDownload` — authenticated mint: RBAC-checks the caller,
 *     verifies the job is `ready|delivered` + not expired, then mints a fresh
 *     single-use token (stores its HMAC on the row) and returns the download URL
 *     token. Called by the presentation when the user clicks "Download".
 *   - `downloadExport` — the proxy core: re-runs RBAC, verifies the presented
 *     token (constant-time, job-bound) + expiry + status, streams the PRIVATE
 *     blob, transitions `ready → delivered`, invalidates the token (single-use),
 *     and audits the download.
 *
 * Authorisation (defence-in-depth layer 2; the route enforces a valid session
 * first → 401): a directory artefact (no subject member) is staff-only; a
 * subject artefact (GDPR) is the subject member OR a same-tenant admin. Tenant
 * isolation is enforced by RLS (the repo self-scopes via ctx) — a cross-tenant
 * job id simply resolves to `not_found`.
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import {
  hashDownloadToken,
  mintDownloadToken,
  verifyDownloadToken,
} from '@/lib/export-download-token';
import type { TenantContext } from '@/modules/tenants';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { ExportJobRecord, ExportJobRepo } from '../ports/export-job-repo';
import type { PrivateBlobPort } from '../ports/private-blob-port';

export type DownloadActorRole = 'admin' | 'manager' | 'member';

export interface DownloadExportMeta {
  readonly actorUserId: string;
  readonly actorRole: DownloadActorRole;
  /** Resolved member id for a member session (null for staff). */
  readonly actorMemberId: string | null;
  readonly requestId: string;
}

/** True when the caller may access this job's artefact. */
function authorize(job: ExportJobRecord, meta: DownloadExportMeta): boolean {
  if (job.subjectMemberId === null) {
    // Directory artefact (E-Book / JSON) — staff only.
    return meta.actorRole === 'admin' || meta.actorRole === 'manager';
  }
  // Subject artefact (GDPR archive) — the subject member or a same-tenant admin.
  if (meta.actorRole === 'admin') return true;
  if (meta.actorRole === 'member') return meta.actorMemberId === job.subjectMemberId;
  return false;
}

function isExpired(job: ExportJobRecord, nowMs: number): boolean {
  if (job.status === 'expired') return true;
  return job.expiresAt !== null && nowMs > job.expiresAt.getTime();
}

function filenameFor(job: ExportJobRecord): string {
  const ext = job.blobKey?.endsWith('.pdf') === true ? 'pdf' : 'json';
  switch (job.kind) {
    case 'directory_ebook':
      return `directory-ebook.${ext}`;
    case 'directory_json':
      return 'directory.json';
    default:
      return `data-export.${ext}`;
  }
}

// --- prepareExportDownload (mint) -------------------------------------------

export interface PrepareExportDownloadDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly clock: ClockPort;
}

export type PrepareExportDownloadError =
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'expired';

export interface PreparedDownload {
  readonly jobId: string;
  readonly token: string;
}

export async function prepareExportDownload(
  input: { readonly jobId: string },
  meta: DownloadExportMeta,
  ctx: TenantContext,
  deps: PrepareExportDownloadDeps,
): Promise<Result<PreparedDownload, PrepareExportDownloadError>> {
  const job = await deps.exportJobRepo.findById(ctx, input.jobId);
  if (job === null) return err('not_found');
  if (!authorize(job, meta)) return err('forbidden');
  if (isExpired(job, deps.clock.now().getTime())) return err('expired');
  if (job.status !== 'ready' && job.status !== 'delivered') return err('not_ready');

  const token = mintDownloadToken();
  const tokenHash = hashDownloadToken(job.id, token);
  const setOk = await runInTenant(ctx, (tx) =>
    deps.exportJobRepo.setDownloadTokenInTx(tx, job.id, tokenHash),
  );
  if (!setOk) return err('not_ready');
  return ok({ jobId: job.id, token });
}

// --- downloadExport (verify + stream) ---------------------------------------

export interface DownloadExportDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly blob: PrivateBlobPort;
  readonly audit: InsightsAuditPort;
  readonly clock: ClockPort;
}

export type DownloadExportError =
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'expired'
  | 'invalid_token';

export interface DownloadExportResult {
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentType: string | null;
  readonly filename: string;
}

export async function downloadExport(
  input: { readonly jobId: string; readonly token: string },
  meta: DownloadExportMeta,
  ctx: TenantContext,
  deps: DownloadExportDeps,
): Promise<Result<DownloadExportResult, DownloadExportError>> {
  const job = await deps.exportJobRepo.findById(ctx, input.jobId);
  if (job === null) return err('not_found');
  if (!authorize(job, meta)) return err('forbidden');
  if (isExpired(job, deps.clock.now().getTime())) return err('expired');
  if (job.status !== 'ready' && job.status !== 'delivered') return err('not_ready');
  if (job.blobKey === null) return err('not_ready');

  // Single-use, job-bound token: a null hash means consumed/never-minted.
  if (job.downloadTokenHash === null) return err('invalid_token');
  if (!verifyDownloadToken(job.id, input.token, job.downloadTokenHash)) {
    return err('invalid_token');
  }

  const obj = await deps.blob.download(job.blobKey);
  if (obj === null) return err('expired'); // artefact swept/absent

  // Consume (single-use) + transition ready→delivered + audit, atomically.
  await runInTenant(ctx, async (tx) => {
    await deps.exportJobRepo.consumeForDownloadInTx(tx, job.id);
    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'data_export_downloaded',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('data_export_downloaded'),
      summary: `export ${job.id} (${job.kind}) downloaded by ${meta.actorRole}`,
      payload: {
        job_id: job.id,
        subject_member_id: job.subjectMemberId ?? '',
      },
    });
  });
  insightsMetrics.exportDownloaded(job.kind, ctx.slug);

  return ok({
    stream: obj.stream,
    contentType: obj.contentType,
    filename: filenameFor(job),
  });
}
