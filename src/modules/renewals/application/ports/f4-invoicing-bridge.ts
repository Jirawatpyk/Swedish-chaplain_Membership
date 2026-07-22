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
  /**
   * The FROZEN-CATALOGUE key — the year keying the `(plan_id, plan_year)` FK
   * + `getAnnualFeeSatang` lookup in F4's `createInvoiceDraft`. `confirmRenewal`
   * derives it SERVER-SIDE from the cycle's `period_from` fiscal year.
   *
   * SAFE-PIN (rolling-anchor axis) — this MAY LAG the printed coverage window
   * by one period on an anchored renewal: the §86/4 face prints the NEXT term
   * (`membershipCoverage` below; `feeYearCe` = that window's start year), while
   * `planYear` stays on the CURRENT term. These are two SEPARATE axes, and §87
   * sequential numbering rides a THIRD one — `invoices.fiscal_year`, derived
   * from the ISSUE / payment date, NEVER this `planYear`. Consumers MUST bucket
   * membership revenue / tax-document counts by `invoices.fiscal_year`, never by
   * `invoices.plan_year`. Keying to `period_from` (not `period_to`) is also
   * what keeps the FIRST anchored renewal issuable — a next-year value would
   * `plan_not_found` (no next-year catalogue row exists yet). Pinned by
   * tests/integration/renewals/confirm-renewal-anchored-plan-year-pin.test.ts.
   */
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

export interface F4InvoicingForRenewalBridge {
  issueInvoiceForRenewal(
    input: IssueInvoiceForRenewalInput,
  ): Promise<IssueInvoiceForRenewalResult>;
}
