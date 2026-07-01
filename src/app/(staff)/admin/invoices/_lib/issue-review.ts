/**
 * 088 T017a / FR-027 — pre-issue review model (pure).
 *
 * Issuing a ใบแจ้งหนี้ pins an IMMUTABLE §86/4 tax snapshot (editable only by
 * void). Before the PATCH is sent, the admin passes a review/confirm step that
 * consolidates the consequential fields. This module owns the two pieces of
 * decision logic that the presentational dialog renders:
 *
 *   1. the Head-Office / Branch line that WILL print on the §86/4 (fail-closed
 *      on an unset `legal_entity_type` — US3 rule: individual / NULL → no line,
 *      juristic → default สำนักงานใหญ่). Branch-code selection (สาขาที่ NNNNN)
 *      lands with US3 (migration 0232, member branch fields) — until then a
 *      juristic buyer previews as Head Office (the US3 default);
 *   2. the non-blocking WARNINGS (acknowledge-to-proceed) the dialog raises:
 *      (a) the bill will render with NO payment path, and
 *      (b) no §86/4 branch line prints because the buyer's `legal_entity_type`
 *          is UNSET (null) — otherwise silent post-cutover.
 *
 * Pure — no framework/DB/network — so it is unit-testable in isolation and the
 * dialog stays a thin presentational shell.
 */

export type IssueReviewWarningCode =
  | 'no_payment_path'
  | 'no_branch_line_null_entity_type';

export type BranchLinePreview =
  | { readonly kind: 'head_office' }
  | {
      readonly kind: 'none';
      /**
       * `individual` — a natural-person buyer; no §86/4 branch line is correct
       * and expected (NOT warned). `unset` — a NULL/blank `legal_entity_type`;
       * the branch line is fail-closed suppressed AND WARN(b) is raised.
       */
      readonly reason: 'individual' | 'unset';
    };

export interface IssueReviewInput {
  /**
   * Buyer `legal_entity_type` (F3 members, free-text). `null`/blank → unset
   * (fail-closed, warned). Case-insensitive `individual` → natural person.
   * Any other non-blank value → a VAT-registrant juristic entity.
   */
  readonly legalEntityType: string | null;
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
  /**
   * Buyer resolves to a VAT-registrant juristic entity (non-null, non-blank,
   * not `individual`). Drives §86/4 branch-line rendering — the US3 fail-closed
   * gate keys on this, NEVER on `buyerHasTin` (spec FR-008 / T032).
   */
  readonly buyerIsVatRegistrantJuristic: boolean;
}

export function computeIssueReviewModel(
  input: IssueReviewInput,
): IssueReviewModel {
  const norm = (input.legalEntityType ?? '').trim().toLowerCase();
  const warnings: IssueReviewWarningCode[] = [];

  let branchLine: BranchLinePreview;
  let buyerIsVatRegistrantJuristic: boolean;
  if (norm === '') {
    branchLine = { kind: 'none', reason: 'unset' };
    buyerIsVatRegistrantJuristic = false;
    warnings.push('no_branch_line_null_entity_type');
  } else if (norm === 'individual') {
    branchLine = { kind: 'none', reason: 'individual' };
    buyerIsVatRegistrantJuristic = false;
  } else {
    branchLine = { kind: 'head_office' };
    buyerIsVatRegistrantJuristic = true;
  }

  if (input.hasNoPaymentPath === true) {
    warnings.push('no_payment_path');
  }

  return { branchLine, warnings, buyerIsVatRegistrantJuristic };
}
