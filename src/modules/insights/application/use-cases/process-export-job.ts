/**
 * F9 US5 `processExportJob` worker use-case (T071).
 *
 * Invoked by the `process-export-jobs` cron per claimable job. Claims the job
 * under a per-(tenant,job) advisory lock (so two workers never collide), builds
 * the artefact from the SC-007-projected published directory, uploads it to
 * **private** Blob at a deterministic per-job key, then marks the job `ready`
 * (+ TTL) and emits the production audit event — all transitions are guarded by
 * the Domain state machine (`export-job.ts`).
 *
 * Directory kinds only here (E-Book / JSON); `gdpr_member_archive` lands in US6.
 * No export may silently fail (FR-037): a build/upload error transitions the job
 * to `failed` and records the error code + metric.
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { DEFAULT_EXPORT_TTL_MS, type ExportKind } from '../../domain/export-job';
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
import type { PrivateBlobPort } from '../ports/private-blob-port';

export interface ProcessExportJobDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly directoryRepo: DirectoryRepo;
  readonly artefact: DirectoryArtefactPort;
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
      logoUrl: row.listing.logoBlobKey,
      locationCity: row.listing.locationCity,
      locationCountry: row.listing.locationCountry,
    },
  };
  return projectPublishedListing(record);
}

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
    if (job.status !== 'requested') return { outcome: 'lost_claim' as const };
    const claimed = await deps.exportJobRepo.claimInTx(tx, jobId);
    if (!claimed) return { outcome: 'lost_claim' as const };
    return { outcome: 'claimed' as const, kind: job.kind };
  });

  if (claim.outcome === 'not_found') return err('not_found');
  if (claim.outcome === 'lost_claim') return err('lost_claim');
  const kind: ExportKind = claim.kind;

  if (kind !== 'directory_ebook' && kind !== 'directory_json') {
    // gdpr_member_archive / audit_export are not handled by this worker yet (US6).
    await runInTenant(ctx, (tx) =>
      deps.exportJobRepo.markFailedInTx(tx, jobId, 'unsupported_kind'),
    );
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('unsupported_kind');
  }

  const startedMs = deps.clock.now().getTime();
  try {
    // 2) Build the artefact from the projected (SC-007) published directory.
    const sourceRows = await runInTenant(ctx, (tx) =>
      deps.directoryRepo.listPublishedInTx(tx),
    );
    const listings = sourceRows
      .map(toPublished)
      .filter((l): l is PublishedListing => l !== null);

    const generatedAtIso = new Date(startedMs).toISOString();
    const artefactInput = {
      tenantName: deps.tenantName,
      locale: deps.tenantDefaultLocale,
      generatedAtIso,
      listings,
    };
    const built =
      kind === 'directory_ebook'
        ? await deps.artefact.buildEbookPdf(artefactInput)
        : await deps.artefact.buildJson(artefactInput);

    // 3) Upload to a deterministic private-Blob key (overwrites on reclaim).
    const blobKey = `exports/${ctx.slug}/${jobId}.${built.extension}`;
    await deps.blob.putPrivate({
      key: blobKey,
      body: built.bytes,
      contentType: built.contentType,
    });

    // 4) Mark ready + emit the production audit event atomically.
    const expiresAt = new Date(deps.clock.now().getTime() + DEFAULT_EXPORT_TTL_MS);
    const eventType =
      kind === 'directory_ebook' ? 'directory_ebook_generated' : 'directory_json_exported';
    await runInTenant(ctx, async (tx) => {
      const marked = await deps.exportJobRepo.markReadyInTx(tx, jobId, {
        blobKey,
        expiresAt,
      });
      if (marked) {
        await deps.audit.recordInTx(tx, {
          tenantId: ctx.slug,
          requestId: null,
          eventType,
          actorUserId: 'system:cron',
          retentionYears: f9RetentionFor(eventType),
          summary: `${kind} artefact produced (job ${jobId}, ${listings.length} listings)`,
          payload: { job_id: jobId },
        });
      }
    });

    insightsMetrics.exportJobProcessed(kind, 'ok', ctx.slug);
    insightsMetrics.exportJobDurationMs(deps.clock.now().getTime() - startedMs, kind);
    return ok({ status: 'ready' });
  } catch (e) {
    logger.error(
      { errKind: errKind(e), kind, route: 'insights.process-export-job' },
      'insights.export_job.build_failed',
    );
    await runInTenant(ctx, (tx) =>
      deps.exportJobRepo.markFailedInTx(tx, jobId, 'build_failed'),
    ).catch(() => {});
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('build_failed');
  }
}
