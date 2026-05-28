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
      logoUrl: row.listing.logoUrl,
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
    // Domain rule (export-job.ts): only a `requested` job is claimable. The SQL
    // claim below is the authoritative guard; this is the defence-in-depth check.
    if (!isClaimable(job.status)) return { outcome: 'lost_claim' as const };
    const claimed = await deps.exportJobRepo.claimInTx(tx, jobId);
    if (!claimed) return { outcome: 'lost_claim' as const };
    return { outcome: 'claimed' as const, kind: job.kind };
  });

  if (claim.outcome === 'not_found') return err('not_found');
  if (claim.outcome === 'lost_claim') return err('lost_claim');
  const kind: ExportKind = claim.kind;

  if (kind !== 'directory_ebook' && kind !== 'directory_json') {
    // gdpr_member_archive / audit_export are not handled by this worker yet (US6).
    // H3: log which kind was mis-enqueued + guard the mark so a failing write
    // can't throw out of the cron's per-job loop and mask the whole tick.
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
      // Guarded UPDATE matched 0 rows — a concurrent reclaim/expire already moved
      // the row out of requested|processing. The state is still terminal, but the
      // lost mark must be observable (parity with the C1 mark_ready_lost path).
      logger.error(
        { kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_lost',
      );
    }
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('unsupported_kind');
  }

  const startedMs = deps.clock.now().getTime();
  // Deterministic per-job key (kind → extension). Computed up-front so the
  // failure paths below can delete an orphaned artefact even when the build /
  // upload partially succeeded (C2 — the TTL sweep only reaps ready|delivered,
  // so a `failed` job's blob would otherwise be orphaned PII forever).
  const extension = kind === 'directory_ebook' ? 'pdf' : 'json';
  const blobKey = `exports/${ctx.slug}/${jobId}.${extension}`;
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

    // 3) Upload to the private Blob (overwrites on reclaim).
    await deps.blob.putPrivate({
      key: blobKey,
      body: built.bytes,
      contentType: built.contentType,
    });

    // 4) Mark ready + emit the production audit event atomically. The guarded
    // UPDATE matches only a still-`processing` row; a concurrent reclaim/expire
    // makes `marked` false (a lost race), in which case we must NOT report success.
    const expiresAt = new Date(deps.clock.now().getTime() + DEFAULT_EXPORT_TTL_MS);
    const eventType =
      kind === 'directory_ebook' ? 'directory_ebook_generated' : 'directory_json_exported';
    const marked = await runInTenant(ctx, async (tx) => {
      const didMark = await deps.exportJobRepo.markReadyInTx(tx, jobId, {
        blobKey,
        expiresAt,
      });
      if (didMark) {
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
      { errKind: errKind(e), kind, route: 'insights.process-export-job' },
      'insights.export_job.build_failed',
    );
    // C2: delete any partially-uploaded artefact (no-op + swallowed if the build
    // threw before upload — `delete` is idempotent).
    await deps.blob.delete(blobKey).catch(() => {});
    // H2: a FAILING failure-mark must be logged+metered, not silently swallowed
    // (otherwise the job wedges in `processing` with no signal). Mirrors the
    // F4 `receiptFailureMarkSuppressed` alert pattern.
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
      // Guarded UPDATE matched 0 rows (a concurrent reclaim/expire beat us). The
      // job is still terminal, but log so the lost mark is observable.
      logger.error(
        { kind, jobId, route: 'insights.process-export-job' },
        'insights.export_job.mark_failed_lost',
      );
    }
    insightsMetrics.exportJobProcessed(kind, 'failed', ctx.slug);
    return err('build_failed');
  }
}
