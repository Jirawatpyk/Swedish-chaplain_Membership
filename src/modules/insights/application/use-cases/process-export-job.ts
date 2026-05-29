/**
 * F9 US5/US6 `processExportJob` worker use-case (T071 / T092).
 *
 * Invoked by the `process-export-jobs` cron per claimable job. Claims the job
 * under a per-(tenant,job) advisory lock (so two workers never collide), builds
 * the artefact, uploads it to **private** Blob at a deterministic per-job key,
 * then marks the job `ready` (+ TTL) and emits the production audit event — all
 * transitions are guarded by the Domain state machine (`export-job.ts`).
 *
 * Kinds handled:
 *   - `directory_ebook` / `directory_json` (US5) — built from the SC-007
 *     projected published directory.
 *   - `gdpr_member_archive` (US6) — the member's data archive (profile,
 *     contacts, invoices + PDFs, events, broadcasts, redacted audit subset,
 *     README + manifest), built by `GdprArchivePort`. A `member_not_found`
 *     subject fails the job (FR-032a/FR-037, no silent failure).
 *   - `audit_export` — not handled here yet (deferred).
 *
 * No export may silently fail (FR-037): a build/upload error transitions the job
 * to `failed`, records the error code + metric, and (for GDPR) emits
 * `data_export_failed`.
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { DEFAULT_EXPORT_TTL_MS, isClaimable, type ExportKind } from '../../domain/export-job';
import {
  projectPublishedListing,
  type DirectoryRecord,
  type PublishedListing,
} from '../../domain/directory-listing';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { DirectoryArtefactPort } from '../ports/directory-artefact-port';
import type { DirectoryRepo, PublishedSourceRow } from '../ports/directory-repo';
import type { ExportJobRepo } from '../ports/export-job-repo';
import type { GdprArchivePort } from '../ports/gdpr-archive-port';
import type { PrivateBlobPort } from '../ports/private-blob-port';

export interface ProcessExportJobDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly directoryRepo: DirectoryRepo;
  readonly artefact: DirectoryArtefactPort;
  readonly gdprArchive: GdprArchivePort;
  readonly blob: PrivateBlobPort;
  readonly audit: InsightsAuditPort;
  readonly clock: ClockPort;
  /** Chamber name for artefact branding. */
  readonly tenantName: string;
  /** Tenant default display locale for the E-Book labels (FR-026). */
  readonly tenantDefaultLocale: string;
}

export type ProcessExportJobError =
  | 'not_found'
  | 'lost_claim'
  | 'unsupported_kind'
  | 'member_not_found'
  | 'build_failed';

function toPublished(row: PublishedSourceRow): PublishedListing | null {
  const record: DirectoryRecord = {
    listed: true,
    fieldVisibility: row.listing.fieldVisibility,
    identity: {
      memberName: row.companyName,
      tier: row.tier,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
    },
    metadata: {
      industry: row.listing.industry,
      description: row.listing.description,
      website: row.listing.website,
      logoUrl: row.listing.logoUrl,
      locationCity: row.listing.locationCity,
      locationCountry: row.listing.locationCountry,
    },
  };
  return projectPublishedListing(record);
}

const EXTENSION_BY_KIND: Record<Exclude<ExportKind, 'audit_export'>, string> = {
  directory_ebook: 'pdf',
  directory_json: 'json',
  gdpr_member_archive: 'zip',
};

export async function processExportJob(
  jobId: string,
  ctx: TenantContext,
  deps: ProcessExportJobDeps,
): Promise<Result<{ readonly status: 'ready' }, ProcessExportJobError>> {
  // 1) Claim under the per-(tenant,job) advisory lock (auto-released at tx end).
  const claim = await runInTenant(ctx, async (tx) => {
    await deps.exportJobRepo.acquireJobLockInTx(tx, jobId);
    const job = await deps.exportJobRepo.findByIdInTx(tx, jobId);
    if (job === null) return { outcome: 'not_found' as const };
    if (!isClaimable(job.status)) return { outcome: 'lost_claim' as const };
    const claimed = await deps.exportJobRepo.claimInTx(tx, jobId);
    if (!claimed) return { outcome: 'lost_claim' as const };
    return {
      outcome: 'claimed' as const,
      kind: job.kind,
      subjectMemberId: job.subjectMemberId,
      requesterLocale: job.requesterLocale,
    };
  });

  if (claim.outcome === 'not_found') return err('not_found');
  if (claim.outcome === 'lost_claim') return err('lost_claim');
  const kind: ExportKind = claim.kind;

  if (kind === 'audit_export') {
    // Not handled by this worker yet. H3: log + guard the mark so a failing
    // write can't throw out of the cron's per-job loop and mask the whole tick.
    logger.error(
      { kind, jobId, route: 'insights.process-export-job' },
      'insights.export_job.unsupported_kind',
    );
    const unsupportedMarked = await runInTenant(ctx, (tx) =>
      deps.exportJobRepo.markFailedInTx(tx, jobId, 'unsupported_kind'),
    ).catch((markErr) => {
      logger.error(
        { errKind: errKind(markErr), kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_failed',
      );
      return null;
    });
    if (unsupportedMarked === false) {
      logger.error(
        { kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_lost',
      );
    }
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('unsupported_kind');
  }

  const startedMs = deps.clock.now().getTime();
  const generatedAtIso = new Date(startedMs).toISOString();
  // Deterministic per-job key (kind → extension). Computed up-front so the
  // failure paths below can delete an orphaned artefact even when the build /
  // upload partially succeeded (C2 — the TTL sweep only reaps ready|delivered,
  // so a `failed` job's blob would otherwise be orphaned PII forever).
  const blobKey = `exports/${ctx.slug}/${jobId}.${EXTENSION_BY_KIND[kind]}`;

  // Best-effort `data_export_failed` emit (GDPR only — FR-037; the directory
  // taxonomy has no failed event). Never throws into the worker loop.
  const emitGdprFailed = async (errorCode: string): Promise<void> => {
    if (kind !== 'gdpr_member_archive') return;
    await deps.audit
      .record({
        tenantId: ctx.slug,
        requestId: null,
        eventType: 'data_export_failed',
        actorUserId: 'system:cron',
        retentionYears: f9RetentionFor('data_export_failed'),
        summary: `GDPR data export failed (job ${jobId}): ${errorCode}`,
        payload: { job_id: jobId, error_code: errorCode },
      })
      .catch(() => {});
  };

  try {
    let built: { readonly bytes: Uint8Array; readonly contentType: string };
    let summary: string;
    let successEvent:
      | 'directory_ebook_generated'
      | 'directory_json_exported'
      | 'data_export_generated';

    if (kind === 'gdpr_member_archive') {
      if (claim.subjectMemberId === null) {
        // A GDPR job must carry a subject; a null subject is a malformed enqueue.
        logger.error(
          { jobId, route: 'insights.process-export-job' },
          'insights.export_job.gdpr_missing_subject',
        );
        await runInTenant(ctx, (tx) =>
          deps.exportJobRepo.markFailedInTx(tx, jobId, 'member_not_found'),
        ).catch(() => null);
        await emitGdprFailed('member_not_found');
        insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
        return err('member_not_found');
      }
      const archive = await deps.gdprArchive.buildArchiveForMember(ctx, {
        subjectMemberId: claim.subjectMemberId,
        requesterLocale: claim.requesterLocale ?? deps.tenantDefaultLocale,
        generatedAtIso,
      });
      if (!archive.ok) {
        // member_not_found (FR-032a: a truly-absent / cross-tenant subject) →
        // fail the job with a clear code (no silent failure, FR-037).
        await runInTenant(ctx, (tx) =>
          deps.exportJobRepo.markFailedInTx(tx, jobId, archive.error),
        ).catch(() => null);
        await emitGdprFailed(archive.error);
        insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
        return err('member_not_found');
      }
      built = archive.value;
      summary = `gdpr_member_archive produced (job ${jobId}, member ${claim.subjectMemberId})`;
      successEvent = 'data_export_generated';
    } else {
      // Directory kinds — build from the SC-007-projected published directory.
      const sourceRows = await runInTenant(ctx, (tx) =>
        deps.directoryRepo.listPublishedInTx(tx),
      );
      const listings = sourceRows
        .map(toPublished)
        .filter((l): l is PublishedListing => l !== null);
      const artefactInput = {
        tenantName: deps.tenantName,
        locale: deps.tenantDefaultLocale,
        generatedAtIso,
        listings,
      };
      built =
        kind === 'directory_ebook'
          ? await deps.artefact.buildEbookPdf(artefactInput)
          : await deps.artefact.buildJson(artefactInput);
      summary = `${kind} artefact produced (job ${jobId}, ${listings.length} listings)`;
      successEvent =
        kind === 'directory_ebook' ? 'directory_ebook_generated' : 'directory_json_exported';
    }

    // Upload to the private Blob (overwrites on reclaim).
    await deps.blob.putPrivate({
      key: blobKey,
      body: built.bytes,
      contentType: built.contentType,
    });

    // Mark ready + emit the production audit event atomically. The guarded
    // UPDATE matches only a still-`processing` row; a concurrent reclaim/expire
    // makes `marked` false (a lost race), in which case we must NOT report success.
    const expiresAt = new Date(deps.clock.now().getTime() + DEFAULT_EXPORT_TTL_MS);
    const marked = await runInTenant(ctx, async (tx) => {
      const didMark = await deps.exportJobRepo.markReadyInTx(tx, jobId, { blobKey, expiresAt });
      if (didMark) {
        // Build the event with the payload discriminated per event type so the
        // F9AuditEvent union narrows (a single object with a union payload won't).
        if (successEvent === 'data_export_generated') {
          await deps.audit.recordInTx(tx, {
            tenantId: ctx.slug,
            requestId: null,
            eventType: 'data_export_generated',
            actorUserId: 'system:cron',
            retentionYears: f9RetentionFor('data_export_generated'),
            summary,
            payload: { job_id: jobId, subject_member_id: claim.subjectMemberId ?? '' },
          });
        } else {
          await deps.audit.recordInTx(tx, {
            tenantId: ctx.slug,
            requestId: null,
            eventType: successEvent,
            actorUserId: 'system:cron',
            retentionYears: f9RetentionFor(successEvent),
            summary,
            payload: { job_id: jobId },
          });
        }
      }
      return didMark;
    });

    if (!marked) {
      // C1: the row left `processing` after the upload (stuck-reclaim / expire
      // race). Never meter 'ok' / return ready when the durable state wasn't
      // advanced — delete the orphan artefact + report the lost race instead.
      await deps.blob.delete(blobKey).catch(() => {});
      logger.error(
        { kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_ready_lost',
      );
      insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
      return err('lost_claim');
    }

    insightsMetrics.exportJobProcessed(kind, 'ok', ctx.slug);
    insightsMetrics.exportJobDurationMs(deps.clock.now().getTime() - startedMs, kind);
    return ok({ status: 'ready' });
  } catch (e) {
    logger.error(
      { errKind: errKind(e), kind, jobId, route: 'insights.process-export-job' },
      'insights.export_job.build_failed',
    );
    // C2: delete any partially-uploaded artefact (no-op + swallowed if the build
    // threw before upload — `delete` is idempotent).
    await deps.blob.delete(blobKey).catch(() => {});
    // H2: a FAILING failure-mark must be logged+metered, not silently swallowed.
    const failMarked = await runInTenant(ctx, (tx) =>
      deps.exportJobRepo.markFailedInTx(tx, jobId, 'build_failed'),
    ).catch((markErr) => {
      logger.error(
        { errKind: errKind(markErr), kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_failed',
      );
      return null;
    });
    if (failMarked === false) {
      logger.error(
        { kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_lost',
      );
    }
    await emitGdprFailed('build_failed');
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('build_failed');
  }
}
