/**
 * 107-auto-invoice Task 14 — `/issue-auto-drafted` + `/discard-auto-draft`
 * error routing (pure).
 *
 * Sibling of `issue-error-routing.ts` (the manual-issue dialog's own
 * router) — kept SEPARATE rather than merged because the two routes carry
 * different code sets (`issueAutoDraftedRenewal`'s `IssueAutoDraftError`
 * vs. the bare `issueInvoice`'s `IssueInvoiceError`) and different UI
 * requirements: this router's `refusal_reason` branch is a HARD REQUIREMENT
 * (Task 14 brief §3) — it must map 1:1 onto the SAME four reasons Task
 * 13's `<AutoRenewalQueueBadges>` predicts (`plan_year_drift` /
 * `member_terminated` / `member_erased` / `duplicate_live_bill`), so the caller renders the
 * identical copy the queue badge already showed for this row via the SAME
 * `admin.invoices.list.queue.refusalReason.*` i18n keys — not a duplicated
 * copy that could drift from Task 13's wording over time.
 *
 * Pure `.ts` leaf (no React import graph) so the classification is
 * unit-testable and the action component stays a thin shell. Defensive —
 * any unlisted/malformed shape degrades to a generic message.
 */

export type IssueAutoDraftErrorRouting =
  | {
      readonly kind: 'refusal_reason';
      /** Relative to `admin.invoices.list.queue.refusalReason.` — the SAME
       * key Task 13's queue badge reads, so wording never drifts. */
      readonly reasonKey:
        | 'planYearDrift'
        | 'planDrift'
        | 'memberTerminated'
        | 'memberErased'
        | 'duplicateLiveBill';
      /** Only set for `duplicateLiveBill` — powers a "View existing bill" link,
       * mirroring `<AutoRenewalQueueBadges>`'s own conflicting-invoice link. */
      readonly conflictingInvoiceId?: string;
    }
  | {
      readonly kind: 'generic';
      /** i18n key relative to `admin.invoices.autoRenewalQueue.actions.errors.`. */
      readonly messageKey: string;
    };

interface IssueAutoDraftErrorBody {
  readonly code?: string;
  readonly reason?: string;
  readonly conflicting_invoice_id?: string;
}

export function routeIssueAutoDraftError(
  body: IssueAutoDraftErrorBody | null | undefined,
): IssueAutoDraftErrorRouting {
  const code = body?.code;

  if (code === 'duplicate_live_bill') {
    return {
      kind: 'refusal_reason',
      reasonKey: 'duplicateLiveBill',
      ...(body?.conflicting_invoice_id
        ? { conflictingInvoiceId: body.conflicting_invoice_id }
        : {}),
    };
  }
  if (code === 'member_terminated') {
    return { kind: 'refusal_reason', reasonKey: 'memberTerminated' };
  }
  if (code === 'member_erased') {
    return { kind: 'refusal_reason', reasonKey: 'memberErased' };
  }
  if (code === 'invalid_draft' && body?.reason === 'plan_year_drift') {
    return { kind: 'refusal_reason', reasonKey: 'planYearDrift' };
  }
  // audit: tax — the member's plan changed after this draft was created, so the
  // draft would mint a §86/4 at the superseded tier. Discard + let the cron
  // re-draft at the current plan.
  if (code === 'invalid_draft' && body?.reason === 'plan_drift') {
    return { kind: 'refusal_reason', reasonKey: 'planDrift' };
  }
  if (code === 'draft_not_found') {
    return { kind: 'generic', messageKey: 'draftNotFound' };
  }
  // Review round 1 MINOR — `cycle_not_found` is a DIFFERENT fact than
  // `draft_not_found`: the invoice ITSELF still exists, untouched, as a
  // draft (Task 7's "orphaned after commit" window — its renewal cycle
  // never got stamped with it). `draftNotFound`'s "may have already been
  // issued or discarded" copy would be actively WRONG here — nothing
  // happened to this draft; its cycle link is what's missing. Own key,
  // own accurate copy.
  if (code === 'cycle_not_found') {
    return { kind: 'generic', messageKey: 'cycleNotFound' };
  }
  if (code === 'invalid_draft') {
    return { kind: 'generic', messageKey: 'invalidDraft' };
  }
  if (code === 'issue_failed') {
    return { kind: 'generic', messageKey: 'issueFailed' };
  }
  return { kind: 'generic', messageKey: 'issueFailed' };
}

/** Sibling router for `/discard-auto-draft` — a much narrower code set. */
export function routeDiscardAutoDraftError(
  code: string | null | undefined,
): string {
  if (code === 'not_draft') return 'discardNotDraft';
  if (code === 'not_found') return 'draftNotFound';
  return 'discardFailed';
}
