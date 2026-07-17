/**
 * 106-void-on-reissue — Task 3: `issueMembershipBill` composition.
 *
 * Composes the UNCHANGED `issueInvoice` primitive with a best-effort
 * supersede-void of the member's strictly-older, still-outstanding new-flow
 * membership bills:
 *
 *   1. `issueInvoice` — its own transaction; commits before anything below
 *      runs. This use-case NEVER touches issueInvoice's internals.
 *   2. `FEATURE_VOID_ON_REISSUE` off → plain issue, no supersede
 *      (`supersedeWarnings: []`).
 *   3. Flag on → list the member's strictly-older `issued` new-flow
 *      membership bills (`listSupersedableMembershipBills` — asymmetric
 *      `(created_at, invoice_id) < bound` ordering, so the JUST-issued bill
 *      is never a candidate for its own supersede pass).
 *   4. Void each candidate, own transaction, best-effort:
 *        - `requireStatus: 'issued'`   — never touch a paid/legacy §86/4.
 *        - `suppressCancellationEmail: true` — this is an automated
 *          administrative supersede, not a member-facing cancellation.
 *        - `supersededByInvoiceId`     — structured audit link to the new
 *          bill, so the trail doesn't rely on parsing free-text voidReason.
 *
 * Failure handling (controller-resolved ambiguity, 2026-07-18):
 *   - `invalid_status` from voidInvoice is an EXPECTED no-op (the bill raced
 *     to paid, was already void, or a legacy §86/4 the repo's shape filter
 *     already excludes) → silently `continue`. No warning, no metric.
 *   - Any OTHER void failure (or a failure to even LIST the candidates) is
 *     METRIC-ONLY (`invoicingMetrics.voidOnReissueFailed`) plus a
 *     `supersedeWarnings` entry on the (still-`ok`) return value. Deliberately
 *     NOT a dedicated audit event and NEVER a reuse of `invoice_voided` (that
 *     event means a bill was successfully voided) — this preserves the
 *     zero-schema-change promise of this feature.
 *   - A supersede failure is NEVER fatal to the issue: the new bill was
 *     already committed in step 1 and is the source of truth regardless of
 *     whether the old duplicate(s) could be cleaned up.
 */
import { ok, type Result } from '@/lib/result';
import { invoicingMetrics } from '@/lib/metrics';
import {
  issueInvoice,
  type IssueInvoiceDeps,
  type IssueInvoiceError,
  type IssueInvoiceInput,
  type IssueInvoiceSuccess,
} from './issue-invoice';
import { voidInvoice, type VoidInvoiceDeps } from './void-invoice';
import type { InvoiceRepo } from '../ports/invoice-repo';

export interface IssueMembershipBillDeps {
  readonly issueDeps: IssueInvoiceDeps;
  readonly voidDeps: VoidInvoiceDeps;
  /** Used ONLY for `listSupersedableMembershipBills` (the read that finds
   * the older bills to supersede) — `issueInvoice`/`voidInvoice` carry their
   * own `invoiceRepo` inside `issueDeps`/`voidDeps`. */
  readonly invoiceRepo: InvoiceRepo;
  /** `env.features.voidOnReissue` — default false (ships dark). */
  readonly voidOnReissueEnabled: boolean;
}

export type IssueMembershipBillSuccess = IssueInvoiceSuccess & {
  /** Best-effort supersede-void failures, human-readable, NEVER fatal to the
   * issue. Empty when the flag is off, nothing was outstanding to supersede,
   * or every supersede-void succeeded (including any that were a swallowed
   * `invalid_status` no-op). */
  readonly supersedeWarnings: readonly string[];
};

export async function issueMembershipBill(
  deps: IssueMembershipBillDeps,
  input: IssueInvoiceInput,
): Promise<Result<IssueMembershipBillSuccess, IssueInvoiceError>> {
  // 1. Issue the new bill (its own tx; commits before we void anything).
  const issued = await issueInvoice(deps.issueDeps, input);
  if (!issued.ok) return issued;

  // 2. Flag OFF → plain issue, no supersede.
  if (!deps.voidOnReissueEnabled) {
    return ok({ ...issued.value, supersedeWarnings: [] });
  }

  // 3. List the member's strictly-older outstanding new-flow membership bills
  //    (asymmetric (created_at, id) < newBill → the newest is never voided →
  //    deterministic single survivor under concurrent same-member issue).
  const newBill = issued.value;
  const supersedeWarnings: string[] = [];
  let older: ReadonlyArray<{ readonly invoiceId: string }> = [];
  // A membership bill's memberId is never null (InvoiceSubjectFields'
  // 'membership' arm requires it) — this guard exists because `Invoice` is a
  // subject-agnostic union at the type level (TS can't narrow on
  // `invoiceSubject` here) and is defence-in-depth against a malformed
  // upstream draft rather than an expected runtime branch.
  if (newBill.memberId) {
    try {
      older = await deps.invoiceRepo.listSupersedableMembershipBills(
        input.tenantId,
        newBill.memberId,
        {
          excludeInvoiceId: newBill.invoiceId,
          createdAt: new Date(newBill.createdAt),
          invoiceId: newBill.invoiceId,
        },
      );
    } catch {
      invoicingMetrics.voidOnReissueFailed(input.tenantId);
      supersedeWarnings.push('supersede: failed to list prior bills');
      return ok({ ...newBill, supersedeWarnings });
    }
  }

  // 4. Void each, own tx, best-effort. Never fatal to the issue.
  for (const bill of older) {
    const voided = await voidInvoice(deps.voidDeps, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      invoiceId: bill.invoiceId,
      voidReason: `auto-void: superseded by renewal reissue ${newBill.invoiceId}`,
      requireStatus: 'issued',
      suppressCancellationEmail: true,
      supersededByInvoiceId: newBill.invoiceId,
    });
    if (!voided.ok) {
      // invalid_status = expected no-op (already void, or raced to paid → correctly preserved).
      if (voided.error.code === 'invalid_status') continue;
      invoicingMetrics.voidOnReissueFailed(input.tenantId);
      supersedeWarnings.push(`supersede: void of ${bill.invoiceId} failed (${voided.error.code})`);
    }
  }
  return ok({ ...newBill, supersedeWarnings });
}
