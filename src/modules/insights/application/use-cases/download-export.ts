/**
 * F9 US5/US6 export download use-cases (T073 / research R6).
 *
 *   - `prepareExportDownload` — authenticated mint: RBAC-checks the caller,
 *     verifies the job is `ready|delivered` + not expired, then mints a fresh
 *     single-use token (stores its HMAC on the row) and returns `{ jobId, token }`;
 *     the route assembles the proxy URL. Called when the user clicks "Download".
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
import { logger } from '@/lib/logger';
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
  switch (job.kind) {
    case 'directory_ebook':
      return 'directory-ebook.pdf';
    case 'directory_json':
      return 'directory.json';
    case 'gdpr_member_archive':
      // The GDPR archive is a ZIP (EXTENSION_BY_KIND in process-export-job.ts);
      // the proxy streams it as application/zip, so the attachment name MUST be
      // `.zip` or the OS won't recognise the archive (the prior `.json` default
      // mislabelled the download — staff-review C1).
      return 'data-export.zip';
    default:
      // audit_export (not yet downloadable) — derive from the stored key.
      return job.blobKey?.endsWith('.pdf') === true ? 'data-export.pdf' : 'data-export.json';
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
  if (obj === null) {
    // H1: the job is ready|delivered + not past TTL (guards above passed) yet
    // the artefact is gone — a genuinely missing/never-uploaded blob, NOT a
    // routine TTL expiry. Log so operators can distinguish "I generated it 5
    // min ago and it says expired" from a real expiry (no blob key in the log).
    logger.error(
      { jobId: job.id, kind: job.kind, route: 'insights.download-export' },
      'insights.export_artefact_missing',
    );
    return err('expired');
  }

  // Consume (single-use) + transition ready→delivered + audit, atomically.
  // The consume is a guarded check-and-consume (repo: status ready|delivered
  // AND downloadTokenHash IS NOT NULL). Under two concurrent downloads of the
  // same token exactly ONE wins; the loser gets `consumed=false` and must NOT
  // stream or audit — otherwise the single-use PII token would be honoured
  // twice and `data_export_downloaded` would fire twice (TOCTOU, finding #11).
  let consumed = false;
  await runInTenant(ctx, async (tx) => {
    consumed = await deps.exportJobRepo.consumeForDownloadInTx(tx, job.id);
    if (!consumed) return;
    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'data_export_downloaded',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('data_export_downloaded'),
      summary: `export ${job.id} (${job.kind}) downloaded by ${meta.actorRole}`,
      payload: {
        job_id: job.id,
        // `data_export_downloaded` fires for BOTH a subject (GDPR) artefact and
        // a directory artefact (no subject). The payload type requires a string,
        // so a directory download records the `''` sentinel (NOT null) — readers
        // treat empty `subject_member_id` as "tenant-wide artefact, no subject".
        subject_member_id: job.subjectMemberId ?? '',
      },
    });
  });

  // Lost the concurrent race (or the token was already consumed): the snapshot
  // verified above, but the row's hash was nulled by the winner. Treat as a
  // spent token — do not stream a second copy.
  if (!consumed) return err('invalid_token');

  insightsMetrics.exportDownloaded(job.kind, ctx.slug);

  return ok({
    stream: obj.stream,
    contentType: obj.contentType,
    filename: filenameFor(job),
  });
}
