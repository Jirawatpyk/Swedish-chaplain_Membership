/**
 * T171a — `prune-expired-drafts.ts` Application use case (F7 US6 / Phase 8).
 *
 * Daily cron worker that deletes draft broadcasts whose `updated_at`
 * is older than `retentionDays` (default 30) per FR-001a. Drafts are
 * user-controlled scratch space; pruning emits no LIFECYCLE audit event and
 * never touches non-draft rows.
 *
 * ROUND-3 #9 — "no audit event" full stop is what this line used to say, and
 * it stopped being true at F2-1: every image row the prune stamps emits
 * `broadcast_image_removed { reason: 'draft_pruned' }` in the DELETE's own
 * transaction. The draft's lifecycle is unrecorded; the member's bytes
 * leaving is not.
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
import { auditImagesRemoved } from './_mark-owner-images-removed';

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
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwners'>;
  readonly audit: AuditPort;
  /** Correlates the audit rows with this cron tick. */
  readonly requestId: string;
  /**
   * ROUND-2 R-M1 — rows per DELETE, and therefore per transaction. Defaults to
   * 500. The tick loops until a batch comes back short or `timeBudgetMs` is
   * spent, so the bound caps how long ONE transaction holds row locks, not how
   * much the tick gets through.
   */
  readonly batchSize?: number;
  /**
   * ROUND-2 R-M1 — wall-clock ceiling for the whole tick, checked BETWEEN
   * batches (never inside one). Defaults to 20 s, comfortably under the
   * route's own budget. A tick that stops early is not a failure: the next
   * daily tick picks up where it left off, oldest first.
   */
  readonly timeBudgetMs?: number;
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
  /** ROUND-2 R-M1 — how many bounded DELETE batches this tick ran. */
  readonly batches: number;
  /**
   * ROUND-2 R-M1 — true when the loop stopped on the time budget rather than
   * on a short batch, i.e. drafts remain for the next tick. Worth a look in
   * the cron log if it is true two days running.
   */
  readonly budgetExhausted: boolean;
}

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_TIME_BUDGET_MS = 20_000;

export async function pruneExpiredDrafts(
  deps: PruneExpiredDraftsDeps,
): Promise<Result<PruneExpiredDraftsOutput, PruneExpiredDraftsError>> {
  const now = deps.clock.now();
  const days = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - days * MS_PER_DAY);

  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeBudgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startedAtMs = now.getTime();

  try {
    let prunedCount = 0;
    let batches = 0;
    let budgetExhausted = false;

    // ROUND-2 R-M1 — ONE transaction per bounded batch, looped. Before this
    // the DELETE had no LIMIT and the stamp ran once per pruned draft, all in
    // a single transaction: N round-trips and row locks on every expired draft
    // of the tenant, held for as long as the slowest one, on a pooled Neon
    // connection where `statement_timeout` is dropped.
    for (;;) {
      // F2-1 — the DELETE and the batch's image stamp co-commit. The use case
      // owns the transaction so the repo's `RETURNING broadcast_id` ids are
      // still inside it when the images are marked: a prune that committed
      // without the stamp is precisely the bug (unreachable bytes), and a
      // stamp that committed without the prune would mark images of a draft
      // that still exists.
      const pruned = await deps.broadcastsRepo.withTx(async (tx) => {
        const page = await deps.broadcastsRepo.pruneExpiredDrafts(
          deps.tenant.slug,
          cutoff,
          tx,
          batchSize,
        );
        if (page.prunedDrafts.length > 0) {
          await stampBatchImages(deps, page.prunedDrafts, now, tx);
        }
        return page;
      });

      prunedCount += pruned.prunedCount;
      batches += 1;

      // A short batch means the cutoff set is exhausted.
      if (pruned.prunedDrafts.length < batchSize) break;
      // Checked BETWEEN batches only — never mid-transaction.
      if (deps.clock.now().getTime() - startedAtMs >= timeBudgetMs) {
        budgetExhausted = true;
        break;
      }
    }

    return ok({
      prunedCount,
      cutoff: cutoff.toISOString(),
      batches,
      budgetExhausted,
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

/**
 * ROUND-2 R-M1 — ONE stamp statement for the whole batch, then the audit rows
 * built from what it returned.
 *
 * The audits are still one per image and still carry the OWNING draft's
 * member in `related_member_id`, so they are grouped by owner before emission
 * — a batched stamp must not cost the audit trail its per-member truth.
 */
async function stampBatchImages(
  deps: Pick<PruneExpiredDraftsDeps, 'imagesRepo' | 'audit' | 'tenant' | 'requestId'>,
  drafts: readonly { readonly broadcastId: string; readonly requestedByMemberId: string | null }[],
  at: Date,
  tx: unknown,
): Promise<void> {
  const stamped = await deps.imagesRepo.markDeletedByOwners(
    deps.tenant.slug,
    'broadcast',
    drafts.map((d) => d.broadcastId),
    at,
    tx,
  );
  if (stamped.length === 0) return;

  const memberByDraft = new Map(drafts.map((d) => [d.broadcastId, d.requestedByMemberId]));
  const byOwner = new Map<string, typeof stamped[number][]>();
  for (const image of stamped) {
    const bucket = byOwner.get(image.ownerId);
    if (bucket === undefined) byOwner.set(image.ownerId, [image]);
    else bucket.push(image);
  }

  for (const [ownerId, images] of byOwner) {
    await auditImagesRemoved(
      deps.audit,
      {
        tenantId: deps.tenant.slug,
        reason: 'draft_pruned',
        at,
        requestId: deps.requestId,
        // The cron holds no session. `'system'` is the truth, and
        // `check:actor-role-truth` forbids inventing a role here.
        actorUserId: 'system',
        actorRole: 'system',
        relatedMemberId: memberByDraft.get(ownerId) ?? null,
      },
      images,
      tx,
    );
  }
}
