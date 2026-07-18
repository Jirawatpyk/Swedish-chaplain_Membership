import type { Satang, ThbDecimal } from '@/lib/money';
import type {
  CreateInvoiceDraftError,
  CreateInvoiceDraftInput,
  IssueInvoiceError,
} from '@/modules/invoicing';

/**
 * F8 → F4 invoice-creation bridge port (Phase 5 Wave B — T122).
 *
 * T122 confirm-renewal needs to compose F4's `createInvoiceDraft` +
 * `issueInvoice` to produce an `issued` invoice the member can pay
 * via F5. Encapsulating the two-step flow into a single bridge keeps
 * T122 free of F4 internals + lets the production adapter compose F4's
 * use-cases via the barrel exports. Mirrors the existing
 * `f4-invoice-bridge.ts` (mark-paid-offline path) and
 * `f5-refund-bridge.ts` (admin-reject-reactivation path).
 *
 * Why a NEW bridge instead of extending `f4-invoice-bridge.ts`:
 *   - The existing bridge's `issueAndMarkPaid` flow records payment
 *     in the same call chain (admin offline path). T122's flow stops
 *     at `issued` — F5 will record the payment later via webhook.
 *   - A separate port keeps the two flows from coupling on a shared
 *     mega-input shape; each branch's contract is narrower + easier
 *     to mock in tests.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface IssueInvoiceForRenewalInput {
  readonly tenantId: string;
  readonly memberId: string;
  /** F2 plan id — frozen on the cycle row at confirmation time. */
  readonly planId: string;
  /** Calendar year (e.g. 2026) of the membership the invoice covers. */
  readonly planYear: number;
  /**
   * FR-022 — the cycle's FROZEN membership price as a `decimal(12,2)`
   * THB string (e.g. "50000.50"), **VAT-EXCLUSIVE**. The §86/4 renewal
   * invoice bills THIS, not the live F2 catalogue price (a tenant may
   * edit the plan price mid-cycle). Server-sourced from the cycle row
   * (`cycle.frozenPlanPriceThb`) inside the confirm-renewal Step-1 tx —
   * NEVER a request body, because a renewal §86/4 is a price-tampering
   * surface on a tax document. The bridge adapter parses this to satang
   * via the shared integer-only `parseThbDecimalToSatang`. Brand-typed
   * (`ThbDecimal`, not bare `string`) so a request-body field / display
   * label cannot be assigned into this tax-document price slot (I-1,
   * 068 speckit-review).
   */
  readonly frozenPlanPriceThb: ThbDecimal;
  /**
   * Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — the
   * exact coverage window for the renewal §86/4, threaded verbatim into
   * `createInvoiceDraft`'s `membershipCoverage`.
   *
   * F1 (final-review, 2026-07-09) — CLASSIFICATION-GATED, not always
   * supplied. `confirm-renewal.ts` classifies the payment via the shared
   * `classifyMembershipPayment` (same classifier every settlement site
   * consumes) before calling this bridge: a `renewal` shape supplies
   * `{ kind: 'window', fromIso, toIso }` — the cycle's known NEXT-period
   * bounds (`periodTo → periodTo + frozenPlanTermMonths`); a
   * `first_payment` shape (the member's one-and-only cycle, never
   * anchored to a real payment) OMITS this field, because the actual
   * re-anchored period doesn't exist yet at invoice-issue time — it's
   * only known once the member pays (see
   * `mark-cycle-complete-from-invoice-paid.ts`'s linked-path re-anchor).
   * Optional (not every bridge caller has resolved a window yet) —
   * omitted, `createInvoiceDraft` falls back to its own default (`{
   * kind: 'from_payment' }`), which is correct for a first payment
   * (prints "from the payment month" — the month that becomes the
   * actual anchor).
   */
  readonly membershipCoverage?: CreateInvoiceDraftInput['membershipCoverage'];
  /** Auto-email the issued PDF to the member's primary contact. */
  readonly autoEmailOnIssue: boolean;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

/**
 * I-2 (068 speckit-review) — the closed error vocabulary the bridge can
 * surface, derived DIRECTLY from the two F4 use-cases it composes
 * (`createInvoiceDraft` -> `issueInvoice`). The bridge forwards the
 * failed F4 error variant's `code` verbatim, so the union of both F4
 * code spaces is exactly what `errorCode` may carry. Deriving (rather
 * than re-listing) makes an F4-side code rename a COMPILE error here
 * instead of a runtime missing-toast — closing the erased-error-
 * vocabulary finding. The `create_failed` arm carries a create-stage
 * code, `issue_failed` an issue-stage code; both are widened to the
 * union for a flat error space the F8 use-case can branch on without
 * coupling to which stage produced it.
 */
export type RenewalInvoiceErrorCode =
  | CreateInvoiceDraftError['code']
  | IssueInvoiceError['code'];

export type IssueInvoiceForRenewalResult =
  | {
      readonly status: 'issued';
      readonly invoiceId: string;
      readonly invoiceNumber: string;
      readonly totalSatang: Satang;
      /**
       * 106-void-on-reissue (Task 4) — best-effort supersede-void warnings
       * from `issueMembershipBill`'s auto-void pass, threaded verbatim.
       * Empty when `FEATURE_VOID_ON_REISSUE` is off, nothing was
       * outstanding to supersede, or every supersede-void succeeded.
       * Optional (not `readonly string[]`) so the F5R3-era callers that
       * predate this field don't need updating just to destructure it.
       */
      readonly supersedeWarnings?: readonly string[];
    }
  | {
      readonly status: 'create_failed';
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    }
  | {
      readonly status: 'issue_failed';
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    };

/**
 * 107-auto-invoice (Task 5) — the auto-invoice cron's DRAFT-only half.
 * Mirrors {@link IssueInvoiceForRenewalInput} minus the issue-specific
 * fields (`autoEmailOnIssue`, `correlationId`) — the cron only drafts; the
 * review-queue "Issue" action (Task 9, `issueExistingDraftForRenewal`)
 * resolves the auto-email decision later, at issue time.
 */
export interface DraftInvoiceForRenewalInput {
  readonly tenantId: string;
  readonly memberId: string;
  /** F2 plan id — frozen on the cycle row at draft time. */
  readonly planId: string;
  /** Calendar year (e.g. 2026) of the membership the invoice covers. */
  readonly planYear: number;
  /** See {@link IssueInvoiceForRenewalInput.frozenPlanPriceThb} — same
   * server-sourced, VAT-EXCLUSIVE, price-tampering-guarded contract. */
  readonly frozenPlanPriceThb: ThbDecimal;
  /** See {@link IssueInvoiceForRenewalInput.membershipCoverage}. */
  readonly membershipCoverage?: CreateInvoiceDraftInput['membershipCoverage'];
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export type DraftInvoiceForRenewalResult =
  | { readonly status: 'drafted'; readonly invoiceId: string }
  | {
      readonly status: 'draft_failed';
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    };

/**
 * 107-auto-invoice (Task 5) — the review-queue "Issue" action's ISSUE-only
 * half, promoting an already-drafted `origin='auto_renewal'` invoice
 * (created by {@link DraftInvoiceForRenewalInput}) to `issued`.
 */
export interface IssueExistingDraftForRenewalInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly actorUserId: string;
  /**
   * The review-queue action's definite send-vs-silent choice at issue time
   * — always a real decision (never "no opinion"), since the auto-drafted
   * invoice itself was always created with `autoEmailOnIssue: false`
   * (deferred — the cron cannot know the eventual choice). Forwarded
   * verbatim as `issueMembershipBill`'s `autoEmailOverride`.
   */
  readonly autoEmailOnIssue: boolean;
  readonly requestId: string | null;
}

/**
 * 107-auto-invoice (Task 9) — discard half. Deletes an auto-drafted invoice
 * that will never be issued.
 *
 * Lives on the bridge rather than on `RenewalCycleRepo` because it WRITES to
 * F4's `invoices` table: the renewals module may read that table for its own
 * guards (see `hasLiveMembershipInvoiceForPlanYearInTx`), but mutating another
 * bounded context's storage directly would breach Constitution Principle III.
 * Composes F4's own `deleteInvoiceDraft` use-case, so the F4 audit
 * (`invoice_draft_deleted`) and the status guard both still apply.
 *
 * Task 14's manual "Discard" queue action consumes this too — the only
 * difference between the two callers is the renewals-side
 * `renewal_auto_draft_discarded.reason` they emit alongside it.
 */
export interface DiscardAutoDraftForRenewalInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/**
 * `not_draft` is a first-class, EXPECTED outcome, not an error: a concurrent
 * issue may have promoted the row since the caller decided to discard it. The
 * caller must treat it as "leave it alone", never retry-as-delete.
 */
export type DiscardAutoDraftForRenewalResult =
  | { readonly status: 'discarded' }
  | { readonly status: 'not_draft' }
  | { readonly status: 'not_found' };

export interface F4InvoicingForRenewalBridge {
  issueInvoiceForRenewal(
    input: IssueInvoiceForRenewalInput,
  ): Promise<IssueInvoiceForRenewalResult>;
  /** 107-auto-invoice (Task 5) — cron create-half. See {@link draftInvoiceForRenewal}'s
   * sibling {@link issueExistingDraftForRenewal} for the review-queue issue-half. */
  draftInvoiceForRenewal(
    input: DraftInvoiceForRenewalInput,
  ): Promise<DraftInvoiceForRenewalResult>;
  /**
   * 107-auto-invoice (Task 5) — review-queue issue-half. Reuses
   * {@link IssueInvoiceForRenewalResult} (the existing `'issued' |
   * 'issue_failed'` arms) — this method never produces the `'create_failed'`
   * arm since there is no create step here.
   */
  issueExistingDraftForRenewal(
    input: IssueExistingDraftForRenewalInput,
  ): Promise<IssueInvoiceForRenewalResult>;
  /** 107-auto-invoice (Task 9) — see {@link DiscardAutoDraftForRenewalInput}. */
  discardAutoDraftForRenewal(
    input: DiscardAutoDraftForRenewalInput,
  ): Promise<DiscardAutoDraftForRenewalResult>;
}
