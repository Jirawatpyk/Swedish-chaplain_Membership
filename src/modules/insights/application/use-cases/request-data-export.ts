/**
 * F9 US6 (T089) — `requestDataExport` use-case.
 *
 * A member exercises GDPR Art. 20 / PDPA portability: enqueues a
 * `gdpr_member_archive` export job for their OWN data. An admin may enqueue the
 * same on a member's behalf for a data-subject request (FR-031), attributed to
 * the admin. The artefact is built later by the async `process-export-jobs`
 * worker (FR-037 hybrid) — this use-case only ENQUEUES + records the request.
 *
 * RBAC (FR-031/032):
 *   - `member` → own-only (`actorMemberId === subjectMemberId`), else forbidden.
 *   - `admin`  → any member (on-behalf).
 *   - `manager`→ forbidden (GDPR export is an admin/DPO action; the read-only
 *     manager role mirrors the download proxy's authorise(), which excludes it).
 *
 * Idempotency (Principle VIII): a per-minute UTC window keys the job, so a
 * rapid double-submit returns the in-flight job rather than a second archive,
 * while a genuine re-request a minute later produces a fresh job reflecting
 * current data. The `data_export_requested` audit is emitted ONLY for a freshly
 * created job, atomically with the insert.
 *
 * The requester's locale is captured here (the session locale) and persisted on
 * the job so the worker renders the README in it (FR-029).
 *
 * Application layer: no ORM imports (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { exportJobIdempotencyInput } from '../../domain/export-job';
import { f9RetentionFor, type InsightsAuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { ExportJobRepo } from '../ports/export-job-repo';

export type RequestDataExportActorRole = 'admin' | 'manager' | 'member';

export interface RequestDataExportInput {
  /** The data subject whose archive is requested. */
  readonly subjectMemberId: string;
}

export interface RequestDataExportMeta {
  readonly actorUserId: string;
  readonly actorRole: RequestDataExportActorRole;
  /** Resolved member id for a member session (null for staff). */
  readonly actorMemberId: string | null;
  /** Requester's session locale — persisted for the worker's README (FR-029). */
  readonly requesterLocale: string;
  readonly requestId: string;
}

export interface RequestDataExportDeps {
  readonly exportJobRepo: ExportJobRepo;
  readonly audit: InsightsAuditPort;
  readonly clock: ClockPort;
}

export type RequestDataExportError = 'forbidden';

export interface RequestDataExportResult {
  readonly jobId: string;
  readonly status: string;
  /** false when a same-window duplicate returned the existing job. */
  readonly created: boolean;
}

/** `YYYY-MM-DDTHH:mm` UTC minute bucket — the idempotency window. */
function minuteBucket(now: Date): string {
  return now.toISOString().slice(0, 16);
}

export async function requestDataExport(
  input: RequestDataExportInput,
  meta: RequestDataExportMeta,
  ctx: TenantContext,
  deps: RequestDataExportDeps,
): Promise<Result<RequestDataExportResult, RequestDataExportError>> {
  // RBAC.
  if (meta.actorRole === 'manager') return err('forbidden');
  if (meta.actorRole === 'member' && meta.actorMemberId !== input.subjectMemberId) {
    return err('forbidden');
  }

  // An admin acting for any member is on-behalf; a member acting on their own
  // record is not (FR-031 attribution).
  const onBehalf = meta.actorMemberId !== input.subjectMemberId;

  const period = minuteBucket(deps.clock.now());
  const idempotencyKey = exportJobIdempotencyInput({
    tenantId: ctx.slug,
    kind: 'gdpr_member_archive',
    subjectMemberId: input.subjectMemberId,
    requestedForPeriod: period,
  });

  const { job, created } = await runInTenant(ctx, async (tx) => {
    const res = await deps.exportJobRepo.createOrGetInTx(tx, {
      kind: 'gdpr_member_archive',
      subjectMemberId: input.subjectMemberId,
      requestedBy: meta.actorUserId,
      requestedForPeriod: period,
      requesterLocale: meta.requesterLocale,
      idempotencyKey,
    });
    // Emit only on a fresh job (no duplicate trail for a deduped re-submit),
    // atomically with the insert so the request + its audit row commit together.
    if (res.created) {
      await deps.audit.recordInTx(tx, {
        tenantId: ctx.slug,
        requestId: meta.requestId,
        eventType: 'data_export_requested',
        actorUserId: meta.actorUserId,
        retentionYears: f9RetentionFor('data_export_requested'),
        summary: `GDPR data export requested for member ${input.subjectMemberId}${
          onBehalf ? ` on behalf by ${meta.actorRole}` : ''
        }`,
        payload: {
          job_id: res.job.id,
          subject_member_id: input.subjectMemberId,
          on_behalf: onBehalf,
        },
      });
    }
    return res;
  });

  return ok({ jobId: job.id, status: job.status, created });
}
