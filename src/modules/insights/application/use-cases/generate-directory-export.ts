/**
 * F9 US5 `generateDirectoryEbook` / `exportDirectoryJson` use-cases (T080/T081).
 *
 * Staff-initiated, ASYNC artefact generation (FR-037 hybrid): the use-case only
 * ENQUEUES an `export_jobs` row and returns a job ref; the cron worker
 * (`processExportJob`) builds the artefact + uploads it to private Blob + sets
 * the job `ready`. The `*_generated` / `*_exported` audit events are emitted by
 * the worker at production time (not here) — there is no "requested" event in
 * the F9 taxonomy for directory artefacts.
 *
 * Staff-only (FR-024/FR-026): admin + the read-only-on-finance manager role may
 * produce directory artefacts (a chamber deliverable, not finance); members are
 * `forbidden`. Each call enqueues a FRESH job (period = generation instant) so
 * staff can regenerate after listings change; the unique idempotency index only
 * dedupes a same-instant double-submit.
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { exportJobIdempotencyInput, type ExportKind, type ExportStatus } from '../../domain/export-job';
import type { ClockPort } from '../ports/clock-port';
import type { ExportJobRepo } from '../ports/export-job-repo';

export type DirectoryExportActorRole = 'admin' | 'manager' | 'member';

export interface GenerateDirectoryExportMeta {
  readonly actorUserId: string;
  readonly actorRole: DirectoryExportActorRole;
  readonly requestId: string;
}

export interface GenerateDirectoryExportDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly clock: ClockPort;
}

export type GenerateDirectoryExportError = 'forbidden';

export interface ExportJobRef {
  readonly jobId: string;
  readonly status: ExportStatus;
  /** false when a same-instant duplicate returned the existing job. */
  readonly created: boolean;
}

async function enqueueDirectoryExport(
  kind: Extract<ExportKind, 'directory_ebook' | 'directory_json'>,
  meta: GenerateDirectoryExportMeta,
  ctx: TenantContext,
  deps: GenerateDirectoryExportDeps,
): Promise<Result<ExportJobRef, GenerateDirectoryExportError>> {
  if (meta.actorRole === 'member') return err('forbidden');

  const period = deps.clock.now().toISOString();
  const idempotencyKey = exportJobIdempotencyInput({
    tenantId: ctx.slug,
    kind,
    subjectMemberId: null,
    requestedForPeriod: period,
  });

  const { job, created } = await runInTenant(ctx, (tx) =>
    deps.exportJobRepo.createOrGetInTx(tx, {
      kind,
      subjectMemberId: null,
      requestedBy: meta.actorUserId,
      requestedForPeriod: period,
      idempotencyKey,
    }),
  );

  return ok({ jobId: job.id, status: job.status, created });
}

export function generateDirectoryEbook(
  meta: GenerateDirectoryExportMeta,
  ctx: TenantContext,
  deps: GenerateDirectoryExportDeps,
): Promise<Result<ExportJobRef, GenerateDirectoryExportError>> {
  return enqueueDirectoryExport('directory_ebook', meta, ctx, deps);
}

export function exportDirectoryJson(
  meta: GenerateDirectoryExportMeta,
  ctx: TenantContext,
  deps: GenerateDirectoryExportDeps,
): Promise<Result<ExportJobRef, GenerateDirectoryExportError>> {
  return enqueueDirectoryExport('directory_json', meta, ctx, deps);
}
