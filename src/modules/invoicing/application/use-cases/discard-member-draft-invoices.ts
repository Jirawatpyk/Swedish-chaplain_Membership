/**
 * F4 `discardMemberDraftInvoices` — the invoicing half of the COMP-1 member
 * erasure cascade (GDPR Art. 17 / PDPA §33).
 *
 * **Retention policy (the whole point of this use-case).** Erasure DISCARDS
 * `draft` invoices and RETAINS everything `issued` and beyond:
 *
 *   - a `draft` carries no §87 sequence number and no statutory retention duty.
 *     It is a pending billing INSTRUCTION for a data subject who has asked to be
 *     forgotten — Art. 5(1)(c) data-minimisation and Art. 17 apply cleanly, so
 *     it goes. It is also, post-erasure, an un-issuable work item: the branch's
 *     `erased_at` gates refuse to issue it, so left alone it becomes a
 *     permanently stuck red row in the treasurer's review queue.
 *   - an `issued` document (and every status after it) is a legally-final Thai
 *     tax record retained under the RD §87/3 legal-obligation carve-out —
 *     GDPR Art. 17(3)(b). This use-case NEVER deletes, voids, or alters one.
 *     The 10-year tax-redaction cron (COMP-1 US3) is the only path that touches
 *     issued documents, and it redacts rather than removes.
 *
 * The retention line is enforced TWICE, deliberately: the candidate scan asks
 * for `status='draft'` only, and F4's own `deleteInvoiceDraft` (which this
 * composes, rather than issuing a second DELETE) re-asserts `status='draft'`
 * inside the DELETE statement itself. A row promoted between the two is
 * reported as skipped — never counted as discarded.
 *
 * Audit: each successful discard emits F4's own `invoice_draft_deleted` (via
 * `deleteInvoiceDraft`, co-committed with the DELETE), so the compliance trail
 * names every invoice removed and by whom. The caller additionally surfaces the
 * aggregate count on the `member_erased` DPO record.
 *
 * Never throws: per-row fault isolation means one bad row cannot strand the
 * rest of the work-list (mirrors `prune-auto-drafts`'s per-candidate try/catch),
 * and the caller is a best-effort post-commit cascade whose non-clean outcome
 * withholds `member_erased` so the US2d reconciler re-drives.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { logger } from '@/lib/logger';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { AuditPort } from '../ports/audit-port';
import { deleteInvoiceDraft } from './delete-invoice-draft';

export interface DiscardMemberDraftInvoicesInput {
  readonly tenantId: string;
  readonly memberId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface DiscardMemberDraftInvoicesOutput {
  /** Drafts actually removed (each emitted its own `invoice_draft_deleted`). */
  readonly discardedCount: number;
  /**
   * Candidates that were NOT removed for a benign reason: promoted to `issued`
   * by a concurrent action, or already gone (a racing prune / manual discard).
   * Benign — but reported, never folded into `discardedCount`.
   */
  readonly skippedCount: number;
  /** Candidates whose discard threw. Non-zero ⇒ the cascade is NOT clean. */
  readonly failedCount: number;
}

export interface DiscardMemberDraftInvoicesDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly audit: AuditPort;
}

const PAGE_SIZE = 100;
/**
 * Bound the scan so a pathological data state cannot spin this cascade forever.
 * 50 × 100 = 5,000 drafts for ONE member — orders of magnitude beyond anything
 * reachable (a member accrues at most a handful). Hitting it is a bug signal,
 * logged loudly; the erasure still reports what it managed to discard.
 */
const MAX_PAGES = 50;

export async function discardMemberDraftInvoices(
  deps: DiscardMemberDraftInvoicesDeps,
  input: DiscardMemberDraftInvoicesInput,
): Promise<DiscardMemberDraftInvoicesOutput> {
  // --- Phase 1: READ the full work-list before deleting anything. -----------
  // Collect ids first rather than delete-as-we-page: draining page 1 repeatedly
  // would never terminate if a candidate refuses to delete (raced to `issued`),
  // and mutating rows underneath an in-flight keyset cursor is needlessly subtle.
  const invoiceIds: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: { readonly rows: ReadonlyArray<{ readonly invoiceId: string }>; readonly nextCursor: string | null } =
      await deps.invoiceRepo.list(input.tenantId, {
        memberId: input.memberId,
        // The retention line. `includeDrafts` must be set too — the repo
        // unconditionally ANDs `status != 'draft'` unless drafts are opted in,
        // so `status: 'draft'` WITHOUT this flag returns the empty set (the #15
        // fix documented on `drizzle-invoice-repo.list`), silently erasing
        // nothing.
        status: 'draft',
        includeDrafts: true,
        pageSize: PAGE_SIZE,
        cursor,
      });
    for (const row of page.rows) invoiceIds.push(row.invoiceId);
    pages += 1;
    if (page.nextCursor === null) break;
    if (pages >= MAX_PAGES) {
      logger.error(
        {
          tenantId: input.tenantId,
          memberId: input.memberId,
          requestId: input.requestId,
          scanned: invoiceIds.length,
          cascade: 'f4_draft_discard',
        },
        'invoicing.erasure.draft_scan_page_cap_hit',
      );
      break;
    }
    cursor = page.nextCursor;
  }

  // --- Phase 2: discard each candidate through F4's own guarded use-case. ---
  let discardedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const invoiceId of invoiceIds) {
    try {
      const result = await deleteInvoiceDraft(
        { invoiceRepo: deps.invoiceRepo, audit: deps.audit },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          invoiceId,
          // The id came from our OWN tenant-scoped scan a moment ago, so a
          // vanished row is a benign race (a concurrent manual discard or the
          // Task 11 prune cron), NOT a cross-tenant intrusion. Emitting the
          // probe event here would flood an alerting signal with self-inflicted
          // noise. See `DeleteInvoiceDraftInput.expectMayHaveVanished`.
          expectMayHaveVanished: true,
        },
      );
      if (result.ok) {
        discardedCount += 1;
      } else {
        // `not_draft` (promoted by a concurrent issue — RETAINED, correctly) or
        // `invoice_not_found` (already gone). Both benign; neither is a discard.
        skippedCount += 1;
        logger.info(
          {
            tenantId: input.tenantId,
            memberId: input.memberId,
            invoiceId,
            requestId: input.requestId,
            // NOT `reason` — the pino redactor scrubs that key repo-wide, which
            // would render this line useless ("[REDACTED]").
            skipCode: result.error.code,
            cascade: 'f4_draft_discard',
          },
          'invoicing.erasure.draft_discard_skipped',
        );
      }
    } catch (e) {
      // Per-row fault isolation: one row's failure must not strand the rest of
      // the work-list. A non-zero failedCount makes the caller's cascade
      // not-clean → `member_erased` withheld → the US2d reconciler re-drives
      // (this use-case is idempotent — a re-drive re-scans and finds only what
      // survives).
      failedCount += 1;
      logger.error(
        {
          // Forbidden-log hygiene: error CLASS only, never the raw message
          // (it can embed SQL parameter values).
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
          tenantId: input.tenantId,
          memberId: input.memberId,
          invoiceId,
          requestId: input.requestId,
          cascade: 'f4_draft_discard',
        },
        'invoicing.erasure.draft_discard_failed',
      );
    }
  }

  return { discardedCount, skippedCount, failedCount };
}
