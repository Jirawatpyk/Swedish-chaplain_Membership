/**
 * 107-auto-invoice Task 11 — `pruneAutoDrafts`.
 *
 * Daily housekeeping cron: discards every `origin='auto_renewal'
 * status='draft'` membership invoice whose stamped cycle
 * (`renewal_cycles.auto_draft_invoice_id`) has LEFT the `upcoming|reminded`
 * eligibility window — the member self-renewed via a fresh
 * `confirmRenewal`/manual issue (their cycle moved to `awaiting_payment` or
 * beyond through a DIFFERENT invoice) or the cycle lapsed after the T-30ish
 * draft (the grace-expiry cron wrote `lapsed`). A draft whose cycle is
 * STILL `upcoming`/`reminded` is a live candidate for
 * `issueAutoDraftedRenewal`'s review queue and must never appear here — the
 * candidate query (`listStaleAutoDrafts`) already enforces that.
 *
 * This is the SAME class of cleanup `issueAutoDraftedRenewal`'s
 * `discardSupersededDrafts` performs (Task 9, "discard on ISSUE" — a
 * sibling draft superseded by the one being issued), but for the sibling
 * timing: a draft that is never issued at all because its cycle moved on
 * without it. `auto-draft-due-renewals.ts`'s module docstring names this
 * cron explicitly: "the content-guard is the double-BILL barrier ... Task
 * 11's prune-auto-drafts sweeps [the stale draft]".
 *
 * Discard goes through the SAME F4 bridge Task 9 uses
 * (`discardAutoDraftForRenewal`, composing F4's own `deleteInvoiceDraft`)
 * — never a direct DELETE on F4's `invoices` table (Constitution
 * Principle III). Each candidate's discard + the `renewal_auto_draft_
 * discarded` audit emit share ONE `runInTenant` transaction (Constitution
 * Principle VIII state↔audit atomicity), mirroring `discardSupersededDrafts`'s
 * own tx-threading — see `DeleteInvoiceDraftDeps`'s doc comment: a caller-
 * supplied tx MUST already be inside a `runInTenant` session for the same
 * tenant, which this satisfies. No per-cycle advisory lock is needed: the
 * bridge's DELETE re-asserts `status='draft'` atomically inside the SQL
 * statement, so a concurrent issue/discard racing the SAME row loses
 * cleanly (`not_draft` / `not_found`) with zero clobber risk — the same
 * "no advisory lock needed" reasoning `prune-consumed-tokens` documents.
 *
 * `expectMayHaveVanished: true` is set on every discard call: the
 * candidate id came from THIS tenant's own scan, so a vanished target by
 * the time we process it is a benign race (a treasurer's concurrent Issue,
 * a manual Discard action, or this SAME cron's own earlier row failing
 * mid-loop and a later pass re-processing) — NOT a cross-tenant intrusion
 * probe. Omitting this flag would flood `invoice_cross_tenant_probe`
 * (an alerting signal) with self-inflicted noise.
 *
 * Per-row fault isolation: one candidate's discard throwing must not abort
 * the whole pass (mirrors `auto-draft-due-renewals.ts`'s per-cycle
 * try/catch and `reconcile-pending-applications.ts`'s per-orphan
 * try/catch).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asMemberId } from '@/modules/members';
import { parseInput } from './_lib/parse-input';
import { SYSTEM_ACTOR_AUTO_INVOICE_CRON } from './auto-draft-due-renewals';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const pruneAutoDraftsInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
});

export type PruneAutoDraftsInput = z.infer<typeof pruneAutoDraftsInputSchema>;

export interface PruneAutoDraftsOutput {
  readonly candidatesFound: number;
  readonly pruned: number;
  /**
   * A candidate the bridge reported as `not_draft` (concurrently promoted
   * to `issued` by a treasurer) or `not_found` (already discarded by a
   * concurrent process). Both are benign, expected races — NOT errors.
   */
  readonly skippedAlreadyGone: number;
  readonly errors: number;
  readonly durationMs: number;
}

export type PruneAutoDraftsError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export type PruneAutoDraftsDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo' | 'auditEmitter' | 'f4InvoicingBridge'
>;

export async function pruneAutoDrafts(
  deps: PruneAutoDraftsDeps,
  rawInput: PruneAutoDraftsInput,
): Promise<Result<PruneAutoDraftsOutput, PruneAutoDraftsError>> {
  const inputResult = parseInput(pruneAutoDraftsInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();
  const candidates = await deps.cyclesRepo.listStaleAutoDrafts(input.tenantId);

  let pruned = 0;
  let skippedAlreadyGone = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      const outcome = await runInTenant(deps.tenant, async (tx) => {
        const result = await deps.f4InvoicingBridge.discardAutoDraftForRenewal({
          tenantId: input.tenantId,
          invoiceId: row.invoiceId,
          actorUserId: SYSTEM_ACTOR_AUTO_INVOICE_CRON,
          requestId: null,
          tx,
          expectMayHaveVanished: true,
        });
        if (result.status !== 'discarded') {
          return result.status;
        }
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_auto_draft_discarded' as const,
            payload: {
              cycle_id: row.cycleId,
              member_id: asMemberId(row.memberId),
              invoice_id: row.invoiceId,
              reason: 'pruned_left_window' as const,
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: null,
            actorRole: 'cron',
            correlationId: input.correlationId,
          },
        );
        return 'discarded' as const;
      });

      if (outcome === 'discarded') {
        pruned += 1;
      } else {
        skippedAlreadyGone += 1;
        logger.info(
          {
            tenantId: input.tenantId,
            invoiceId: row.invoiceId,
            cycleId: row.cycleId,
            outcome,
          },
          '[prune-auto-drafts] candidate not discarded (concurrently promoted or already gone) — skipping',
        );
      }
    } catch (e) {
      errors += 1;
      logger.error(
        {
          errorId: 'F8.PRUNE_AUTO_DRAFTS.ROW_FAILED',
          tenantId: input.tenantId,
          invoiceId: row.invoiceId,
          cycleId: row.cycleId,
          err: e instanceof Error ? e : new Error(String(e)),
        },
        '[prune-auto-drafts] candidate discard threw — counted in errors; cron continues',
      );
    }
  }

  return ok({
    candidatesFound: candidates.length,
    pruned,
    skippedAlreadyGone,
    errors,
    durationMs: Date.now() - startedAt,
  });
}
