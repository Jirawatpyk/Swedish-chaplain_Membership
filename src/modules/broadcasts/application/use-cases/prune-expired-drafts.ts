/**
 * T171a — `prune-expired-drafts.ts` Application use case (F7 US6 / Phase 8).
 *
 * Daily cron worker that deletes draft broadcasts whose `updated_at`
 * is older than `retentionDays` (default 30) per FR-001a. Drafts are
 * user-controlled scratch space; pruning emits NO audit event and
 * never touches non-draft rows.
 *
 * Tenant-scoped: invoked once per tenant (single-tenant SweCham MVP;
 * future SaaS multi-tenant iterates the tenant catalogue at the route
 * layer per Phase 9 / F10 scope).
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import { markOwnerImagesRemoved } from './_mark-owner-images-removed';

export type PruneExpiredDraftsError = {
  readonly kind: 'prune.server_error';
  readonly message: string;
};

export interface PruneExpiredDraftsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly clock: ClockPort;
  /**
   * F119 review finding F2-1 — a pruned draft's images. `owner_id` has no FK,
   * so the DELETE left the image rows live and un-stamped, which made them
   * invisible to the sweep (it reads `deleted_at IS NOT NULL`) and to erasure:
   * the member's bytes stayed at a public blob URL forever.
   */
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwner'>;
  readonly audit: AuditPort;
  /** Correlates the audit rows with this cron tick. */
  readonly requestId: string;
  /**
   * Retention window in days. Defaults to 30 (FR-001a). Tests + future
   * tenant overrides may pass a custom value; production cron always
   * passes 30 (or omits → default).
   */
  readonly retentionDays?: number;
}

export interface PruneExpiredDraftsOutput {
  readonly prunedCount: number;
  /** ISO-8601 cutoff used for the query — surfaced for cron logs. */
  readonly cutoff: string;
}

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function pruneExpiredDrafts(
  deps: PruneExpiredDraftsDeps,
): Promise<Result<PruneExpiredDraftsOutput, PruneExpiredDraftsError>> {
  const now = deps.clock.now();
  const days = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);

  try {
    // F2-1 — the DELETE and every image stamp co-commit. The use case owns the
    // transaction so the repo's `RETURNING broadcast_id` ids are still inside
    // it when the images are marked: a prune that committed without the stamp
    // is precisely the bug (unreachable bytes), and a stamp that committed
    // without the prune would mark images of a draft that still exists.
    const result = await deps.broadcastsRepo.withTx(async (tx) => {
      const pruned = await deps.broadcastsRepo.pruneExpiredDrafts(deps.tenant.slug, cutoff, tx);
      for (const draft of pruned.prunedDrafts) {
        await markOwnerImagesRemoved(
          { imagesRepo: deps.imagesRepo, audit: deps.audit },
          {
            tenantId: deps.tenant.slug,
            owner: { kind: 'broadcast', id: draft.broadcastId },
            reason: 'draft_pruned',
            at: now,
            requestId: deps.requestId,
            // The cron holds no session. `'system'` is the truth, and
            // `check:actor-role-truth` forbids inventing a role here.
            actorUserId: 'system',
            actorRole: 'system',
            relatedMemberId: draft.requestedByMemberId,
          },
          tx,
        );
      }
      return pruned;
    });
    return ok({
      prunedCount: result.prunedCount,
      cutoff: cutoff.toISOString(),
    });
  } catch (e) {
    // Repository / DB outage — surface as a structured server error so
    // the cron route can log + return 500 (cron-job.org will retry on
    // next daily tick). NO partial state to roll back: a failed DELETE
    // leaves drafts intact (acceptable — they were going to be pruned
    // anyway, just delayed by 24h).
    //
    // Verify-fix R3 (Errors-C2, 2026-05-02): use `err()` helper instead
    // of hand-cast — aligns with the rest of the F7 module (mirrors
    // `ok()` import on line 15). Hand-cast bypassed the discriminated-
    // union helper and risked silent shape drift if `Result<T,E>` ever
    // gains a brand or normalisation step.
    const message = e instanceof Error ? e.message : 'unknown error';
    // Truncate to bound log size + prevent PII (e.g., constraint-
    // violation messages with row data) from leaking into audit.
    const safeMessage = message.length > 500 ? message.slice(0, 500) + '…' : message;
    return err({ kind: 'prune.server_error', message: safeMessage });
  }
}
