/**
 * 088 T017a / FR-027 — pre-issue review model (pure).
 *
 * Issuing a ใบแจ้งหนี้ pins an IMMUTABLE §86/4 tax snapshot (editable only by
 * void). Before the PATCH is sent, the admin passes a review/confirm step that
 * consolidates the consequential fields. This module owns the two pieces of
 * decision logic that the presentational dialog renders:
 *
 *   1. the Head-Office / Branch line that WILL print on the §86/4 — drawn only
 *      for a VAT-registrant buyer (ประกาศอธิบดีฯ ฉบับที่ 199), gated on the
 *      RECORDED `members.is_vat_registered` flag, never on `buyerHasTin`;
 *   2. the non-blocking WARNINGS (acknowledge-to-proceed) the dialog raises:
 *      (a) the bill will render with NO payment path, and
 *      (b) no §86/4 branch line prints because the buyer is not a recorded VAT
 *          registrant — otherwise silent post-cutover.
 *
 * Pure — no framework/DB/network — so it is unit-testable in isolation and the
 * dialog stays a thin presentational shell.
 */

export type IssueReviewWarningCode =
  | 'no_payment_path'
  | 'no_branch_line_not_vat_registrant';

export type BranchLinePreview =
  | { readonly kind: 'head_office' }
  | { readonly kind: 'none'; readonly reason: 'not_registrant' };

export interface IssueReviewInput {
  /**
   * `members.is_vat_registered` — the RECORDED fact, never derived. This used to
   * take `legalEntityType: string | null` and re-implement the discriminator by
   * hand (`norm === 'individual'`), independently of the adapter that produces
   * the snapshot the PDF actually renders. Two copies of one rule is how a
   * preview comes to contradict the document. See migration 0246.
   */
  readonly buyerIsVatRegistrant: boolean;
  /**
   * FR-027 WARN(a): the bill will render with NO payment path — online-pay is
   * OFF **and** the tenant offline-payment bank block (FR-022) is empty. The
   * caller composes this from F5 online-pay + the US5 bank block; while the
   * bank-block half is unbuilt (US5 / migration 0233) the caller passes
   * `undefined` and the warning stays dormant (never a false positive).
   */
  readonly hasNoPaymentPath?: boolean;
}

export interface IssueReviewModel {
  readonly branchLine: BranchLinePreview;
  readonly warnings: readonly IssueReviewWarningCode[];
}

export function computeIssueReviewModel(
  input: IssueReviewInput,
): IssueReviewModel {
  const warnings: IssueReviewWarningCode[] = [];

  const branchLine: BranchLinePreview = input.buyerIsVatRegistrant
    ? { kind: 'head_office' }
    : { kind: 'none', reason: 'not_registrant' };

  if (!input.buyerIsVatRegistrant) {
    warnings.push('no_branch_line_not_vat_registrant');
  }
  if (input.hasNoPaymentPath === true) {
    warnings.push('no_payment_path');
  }

  return { branchLine, warnings };
}
