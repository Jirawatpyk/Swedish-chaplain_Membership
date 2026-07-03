/**
 * T030 — Invoice aggregate root (F4).
 *
 * State machine:
 *
 *   draft ──issue──> issued ──pay──> paid ──partial-credit──> partially_credited
 *                     │                │                          │
 *                     │                └──full-credit──>  credited
 *                     │                                          │
 *                     └──void──> void                  full-credit
 *
 * Terminal states: void, credited. No further transitions allowed.
 *
 * Invariants:
 *  - enforce-terminal-state-no-edit
 *  - enforce-sequence-monotone-increasing (allocator-level, not per-invoice)
 *  - draft has no sequence number; non-draft has all snapshots set
 *  - `credited_total_satang` ≤ `total_satang`; status matches ratio
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Money } from './value-objects/money';
import type { DocumentNumber } from './value-objects/document-number';
import type { FiscalYear } from './value-objects/fiscal-year';
import type { VatRate } from './value-objects/vat-rate';
import type { ProRatePolicy } from './value-objects/pro-rate-policy';
import type { TenantIdentitySnapshot } from './value-objects/tenant-identity-snapshot';
import type { MemberIdentitySnapshot } from './value-objects/member-identity-snapshot';
import type { Sha256Hex } from './value-objects/sha256-hex';
import type { VatTreatment } from './policies/vat-treatment';
import type { InvoiceLine } from './invoice-line';

export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * 054-event-fee-invoices (NF-C) — upper bound on an event-fee invoice
 * amount, in satang. `100_000_000` satang = 1,000,000.00 THB. A single
 * event ticket fee above one million baht is almost certainly an
 * operator typo (an extra trailing zero) rather than a real charge, so
 * we reject it as `invalid_amount` rather than persist it.
 *
 * Shared (defense-in-depth) by `createEventInvoiceDraft`'s zod schema
 * (`amountOverride.max(...)`), its defensive in-body re-check of the
 * ticket-price-derived amount, and the route-handler zod. Exported via
 * the invoicing barrel so the route + form layers bound the same value.
 */
export const MAX_EVENT_INVOICE_SATANG = 100_000_000;

declare const InvoiceIdBrand: unique symbol;
export type InvoiceId = string & { readonly [InvoiceIdBrand]: true };

// UUID v4 (any variant) — InvoiceIds are `uuid` columns on Postgres.
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvoiceIdError = { kind: 'invalid_invoice_id'; raw: string };

/**
 * Unchecked brand cast. Use in TRUSTED contexts only:
 *   - DB row → domain mapping (the DB enforces uuid format)
 *   - IDs just generated with `randomUUID()`
 *   - Test fixtures
 *
 * For user-supplied input (route parameters, request bodies), use
 * `parseInvoiceId` which validates UUID format first — letting a
 * malformed id reach Drizzle would trigger Postgres `22P02
 * invalid_text_representation` (an opaque 5xx instead of a clean
 * `invoice_not_found` 404).
 */
export function asInvoiceId(raw: string): InvoiceId {
  return raw as InvoiceId;
}

/**
 * Validate-and-brand an InvoiceId from an untrusted source. Returns
 * a Result so the caller can surface a clean 400 `invalid_invoice_id`.
 * Post-review 2026-04-19 agent finding.
 */
export function parseInvoiceId(
  raw: string,
): { ok: true; value: InvoiceId } | { ok: false; error: InvoiceIdError } {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return { ok: false, error: { kind: 'invalid_invoice_id', raw } };
  }
  return { ok: true, value: raw as InvoiceId };
}

/**
 * 054-event-fee-invoices — the subject-specific identity partition.
 *
 * `Invoice` is a DISCRIMINATED UNION on `invoiceSubject`, so illegal field
 * combinations are unrepresentable at compile time (mirroring the DB CHECK
 * `invoices_subject_fields_ck` tightened by migration 0208). Narrowing on
 * `invoiceSubject` yields the per-arm non-null / null guarantees:
 *
 *   - `'membership'`  ⇒ member_id + plan_id + plan_year present (NON-NULL),
 *                       event_id + event_registration_id are `null`, and the
 *                       invoice is VAT-EXCLUSIVE (`vatInclusive: false`).
 *   - `'event'`       ⇒ event_id + event_registration_id present (NON-NULL),
 *                       plan_id + plan_year are `null`, member_id may be a
 *                       matched member (`string`) or a non-member buyer
 *                       (`null`), and the ticket may be priced VAT-inclusive
 *                       or VAT-exclusive (`vatInclusive: boolean`).
 *
 * All subject-specific fields are kept PRESENT on both arms (typed `null` on
 * the off-subject arm) so consumers that only read shared financial /
 * numbering / snapshot fields need no narrowing — only the per-arm literal
 * types differ.
 */
export type InvoiceSubjectFields =
  | {
      readonly invoiceSubject: 'membership';
      readonly memberId: string;
      readonly planId: string;
      readonly planYear: number;
      readonly eventId: null;
      readonly eventRegistrationId: null;
      /** Membership invoices are VAT-EXCLUSIVE. */
      readonly vatInclusive: false;
    }
  | {
      readonly invoiceSubject: 'event';
      /**
       * Set when the attendee is a matched member; `null` for a non-member
       * buyer billed for the ticket.
       */
      readonly memberId: string | null;
      readonly planId: null;
      readonly planYear: null;
      /** F6 event id. */
      readonly eventId: string;
      /** F6 event_registrations id. */
      readonly eventRegistrationId: string;
      /**
       * VAT treatment. Event invoices may be VAT-INCLUSIVE (`true`) when the
       * ticket price already embeds the 7% component, or VAT-EXCLUSIVE
       * (`false`).
       */
      readonly vatInclusive: boolean;
    };

/**
 * Shared (subject-agnostic) Invoice fields — financial, numbering, lifecycle,
 * snapshot, payment, void, and PDF metadata. Combined with
 * {@link InvoiceSubjectFields} to form the full {@link Invoice} discriminated
 * union. `memberIdentitySnapshot` (the BUYER snapshot) lives here because its
 * shape is identical for both subjects — only the semantic source differs.
 */
export interface InvoiceCommon {
  readonly tenantId: string;
  readonly invoiceId: InvoiceId;

  readonly status: InvoiceStatus;
  readonly draftByUserId: string;

  // Numbering (null when draft)
  readonly fiscalYear: FiscalYear | null;
  readonly sequenceNumber: number | null;
  readonly documentNumber: DocumentNumber | null;

  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly paidAt: string | null;
  readonly voidedAt: string | null;

  // Pricing (null when draft)
  readonly currency: 'THB';
  readonly subtotal: Money | null;
  readonly vatRate: VatRate | null;
  readonly vat: Money | null;
  readonly total: Money | null;
  readonly creditedTotal: Money;

  readonly proRatePolicy: ProRatePolicy | null;
  readonly netDays: number | null;

  readonly tenantIdentitySnapshot: TenantIdentitySnapshot | null;
  /**
   * BUYER identity snapshot, frozen at issue time. For
   * `invoiceSubject === 'membership'` this is the member; for `'event'`
   * it is the registrant/attendee billed for the ticket. The shape is
   * identical (legal name / tax id / address) so the type is unchanged —
   * only the semantic source differs by subject.
   */
  readonly memberIdentitySnapshot: MemberIdentitySnapshot | null;

  // Payment (null unless paid)
  readonly paymentMethod: string | null;
  readonly paymentReference: string | null;
  readonly paymentNotes: string | null;
  readonly paymentRecordedByUserId: string | null;
  /**
   * R7-W5 — admin-entered payment date (`YYYY-MM-DD`), separate from
   * `paidAt` which is the server-side "mark paid" timestamp. The
   * latter is `now()` at the moment admin clicks Record Payment; the
   * former may be earlier (the admin is recording a bank transfer
   * dated 2 days ago). Both surface on the detail page and PDF.
   */
  readonly paymentDate: string | null;

  // Void (null unless void)
  readonly voidReason: string | null;
  readonly voidedByUserId: string | null;

  readonly autoEmailOnIssue: boolean | null;

  /**
   * Invoice PDF metadata — frozen at issue time, NEVER overwritten.
   * Present iff the invoice has been issued. All three sub-fields
   * travel together: `blobKey` alone is meaningless without the
   * corresponding `sha256` (content-address) and `templateVersion`
   * (so re-render uses the pinned template). The discriminated shape
   * makes the "all-or-nothing" invariant a compile-time guarantee.
   */
  readonly pdf: {
    readonly blobKey: string;
    readonly sha256: Sha256Hex;
    readonly templateVersion: number;
  } | null;

  /**
   * 064 — WHAT the main {@link pdf} document actually is, persisted at issue
   * time: §86/4 'invoice', combined §86/4+§105ทวิ 'receipt_combined', or §105
   * 'receipt_separate'. NULL on draft ONLY (no main PDF yet) — the DB CHECK
   * `invoices_non_draft_has_doc_kind` enforces presence on every non-draft
   * row. Downstream re-renders (J2 credit-note annotation) MUST branch on
   * this instead of re-deriving, so a receipt-titled original can never be
   * overwritten by an invoice-titled document.
   */
  readonly pdfDocKind: 'invoice' | 'receipt_combined' | 'receipt_separate' | null;

  /**
   * Receipt PDF metadata — written by record-payment at payment time for BOTH
   * numbering modes (separate from `pdf` so the invoice's issue-time hash stays
   * intact for audit). Null on draft/issued; **non-null on paid in either mode**
   * — combined-mode reuses the invoice document number, separate-mode allocates
   * its own; the file header differs (ใบกำกับภาษี/ใบเสร็จรับเงิน vs ใบเสร็จรับเงิน /
   * Official Receipt). See record-payment.ts § "Why two files…". (NB: code is the
   * source of truth — the FR-026 resend-failure banner relies on this being
   * non-null on paid to offer a receipt resend.)
   */
  readonly receiptPdf: {
    readonly blobKey: string;
    readonly sha256: Sha256Hex;
    readonly templateVersion: number;
  } | null;

  /**
   * T166 — async receipt PDF state machine. NULL on draft/issued/void/
   * credited rows; one of `'pending' | 'rendered' | 'failed'` on `paid`
   * rows. CHECK constraint `invoices_paid_has_receipt_status`
   * (migration 0056) enforces this. The `inline` (synchronous render)
   * path always lands rows in `'rendered'`; the async path (T166-03
   * flag on) lands rows in `'pending'` and the worker (T166-05) flips
   * to `'rendered'` once bytes upload.
   */
  readonly receiptPdfStatus: 'pending' | 'rendered' | 'failed' | null;
  readonly receiptPdfRenderAttempts: number;
  readonly receiptPdfLastError: string | null;
  /**
   * T166 R1-C1 — pre-allocated receipt doc number for separate-mode
   * async render. NULL for combined-mode, pre-T166 paid rows, and any
   * non-paid invoice. The render worker reads THIS field instead of
   * calling `sequenceAllocator.allocateNext` (which would create a §87
   * gap on every retry).
   */
  readonly receiptDocumentNumberRaw: string | null;
  /**
   * 088-invoice-tax-flow-redesign (US1) — the pre-payment ใบแจ้งหนี้'s
   * NON-§87 bill number (e.g. `SC-2026-000123`), allocated at issue from the
   * `bill` stream when `FEATURE_088_TAX_AT_PAYMENT` is on. Disjoint from
   * `sequenceNumber`/`documentNumber` (which stay NULL for a non-§87 bill), so
   * it can never enter the §87 uniqueness index (SC-003). NULL on drafts, on
   * every pre-088 row, and on the legacy §87-at-issue path (flag off). Written
   * once in the draft→issued UPDATE, then locked by the immutability trigger.
   */
  readonly billDocumentNumberRaw: string | null;

  /**
   * 088-invoice-tax-flow-redesign (US8 / § F.8) — per-invoice VAT treatment
   * (case-by-case, NOT per-member), pinned at issue + immutable (FR-023):
   * 'standard' (VAT 7%, membership + all defaults) or 'zero_rated_80_1_5'
   * (VAT 0% embassy / int'l-org §80/1(5)). The DB column is NOT NULL DEFAULT
   * 'standard', so every persisted row (incl. pre-088) resolves to a value.
   * DRIVES the VAT rate (FR-025 / G3).
   */
  readonly vatTreatment: VatTreatment;
  /**
   * MFA (Protocol Dept) certificate particulars for a `'zero_rated_80_1_5'`
   * invoice — REQUIRED when zero-rated (fail-closed, FR-024), NULL otherwise.
   * The cert is REFERENCED by number/date on the §86/4 tax invoice; the scan
   * (`zeroRateCertBlobKey`) is retained separately (10y, admin-only) and NOT
   * appended to the PDF (G6).
   */
  readonly zeroRateCertNo: string | null;
  readonly zeroRateCertDate: string | null;
  readonly zeroRateCertBlobKey: string | null;

  readonly lines: readonly InvoiceLine[];

  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 054-event-fee-invoices — Invoice aggregate root, modelled as a REAL
 * discriminated union on `invoiceSubject` so illegal states are
 * unrepresentable. Narrowing `if (invoice.invoiceSubject === 'membership')`
 * widens `memberId`/`planId`/`planYear` to their non-null types and narrows
 * `eventId`/`eventRegistrationId` to `null`; the `'event'` arm does the
 * reverse. Constructing a membership invoice with `eventId` set (or
 * `vatInclusive: true`) is now a COMPILE error.
 *
 * See {@link InvoiceCommon} (shared fields) + {@link InvoiceSubjectFields}
 * (per-subject identity partition).
 */
export type Invoice = InvoiceCommon & InvoiceSubjectFields;

export type InvoiceTransitionError =
  | { code: 'invalid_transition'; from: InvoiceStatus; to: InvoiceStatus }
  | { code: 'terminal_state'; status: InvoiceStatus }
  | { code: 'missing_snapshot'; field: string }
  | { code: 'no_membership_line' }
  | { code: 'multiple_membership_lines'; count: number }
  | { code: 'no_event_fee_line' }
  | { code: 'multiple_event_fee_lines'; count: number };

export function isTerminal(status: InvoiceStatus): boolean {
  return status === 'void' || status === 'credited';
}

/**
 * 064 remediation (A1) — the printed §87/§105 number an invoice row should
 * be DISPLAYED under, shared by the admin detail/list, the portal list/card/
 * detail, and the more-menu so every surface resolves the same number.
 *
 * - Normal rows (membership, bill-first event, as-paid TIN event): the
 *   invoice-stream `documentNumber` — even when a separate-mode RC receipt
 *   number also exists, the invoice number stays the row's identity.
 * - β as-paid no-TIN event rows (and legacy issued no-TIN event rows): the
 *   invoice-stream pair is legitimately NULL and the printed §105 number
 *   lives in `receiptDocumentNumberRaw` — fall back to it so the row never
 *   renders as a "Draft" / em-dash / raw UUID.
 * - True drafts: both NULL → `null` (callers supply their own draft label).
 *
 * Pure + framework-free (Domain); accepts the narrow Pick so presentation
 * view-models that only carry the two raw strings can call it too.
 */
export function displayDocumentNumber(inv: {
  readonly documentNumber: DocumentNumber | null;
  readonly receiptDocumentNumberRaw: string | null;
}): string | null {
  return inv.documentNumber?.raw ?? inv.receiptDocumentNumberRaw;
}

/**
 * FR-017 — the identity number an ISSUED invoice is CONFIRMED/VOIDED under: the
 * §87 `documentNumber` (legacy §87-at-issue flow) OR the non-§87 ใบแจ้งหนี้ bill
 * number (`billDocumentNumberRaw`, the 088 tax-at-payment flow where
 * `documentNumber` stays NULL until — and unless — a receipt is minted at
 * payment). NULL only for a draft/corrupt row that carries neither.
 *
 * Sibling of {@link displayDocumentNumber}, which CANNOT be reused by the void
 * guard: it falls back to the RC receipt number (`receiptDocumentNumberRaw`),
 * whereas voiding acts on the PRE-payment bill, whose identity is the bill
 * number. Pure + framework-free (Domain); accepts the narrow inline shape so
 * presentation view-models carrying only the two raw fields can call it too.
 */
export function issuedInvoiceIdentity(inv: {
  readonly documentNumber: DocumentNumber | null;
  readonly billDocumentNumberRaw: string | null;
}): string | null {
  return inv.documentNumber?.raw ?? inv.billDocumentNumberRaw ?? null;
}

/**
 * LOW-14 — per-subject rule for the "exactly-one subject-defining line"
 * invariant. Each subject pins (1) the line `kind` that must appear exactly
 * once and (2) the two error builders for the 0-line and >1-line cases. A new
 * invoice subject adds ONE entry here and cannot diverge the count logic from
 * the other subjects (the count-and-compare lives in `enforceOneSubjectLine`,
 * not per branch). Error codes + shapes are UNCHANGED — callers/tests pin the
 * same `no_*_line` / `multiple_*_lines` contract.
 */
const SUBJECT_LINE_RULES: Record<
  'membership' | 'event',
  {
    readonly kind: InvoiceLine['kind'];
    readonly zero: InvoiceTransitionError;
    readonly many: (count: number) => InvoiceTransitionError;
  }
> = {
  membership: {
    kind: 'membership_fee',
    zero: { code: 'no_membership_line' },
    many: (count) => ({ code: 'multiple_membership_lines', count }),
  },
  event: {
    kind: 'event_fee',
    zero: { code: 'no_event_fee_line' },
    many: (count) => ({ code: 'multiple_event_fee_lines', count }),
  },
};

/**
 * Draft invariant: exactly one subject-defining line required before
 * issue — `membership_fee` for a `'membership'` invoice, `event_fee`
 * for an `'event'` invoice. Enforced at Application layer on transition
 * to `issued`.
 *
 * The `'membership'` rule carries the `no_membership_line` /
 * `multiple_membership_lines` error contract (formerly the standalone
 * `enforceOneMembershipLine`, removed in Task 7 once `issue-invoice` became
 * the last caller). The `'event'` rule mirrors the same shape for `event_fee`
 * lines. Both are driven by the shared `SUBJECT_LINE_RULES` table (LOW-14) so
 * the count-and-compare logic exists in exactly one place.
 */
export function enforceOneSubjectLine(
  subject: 'membership' | 'event',
  lines: readonly InvoiceLine[],
): Result<void, InvoiceTransitionError> {
  const rule = SUBJECT_LINE_RULES[subject];
  const count = lines.filter((l) => l.kind === rule.kind).length;
  if (count === 0) return err(rule.zero);
  if (count > 1) return err(rule.many(count));
  return ok(undefined);
}

/**
 * Snapshot-completeness guard: all non-draft invoices must have the
 * snapshot columns populated. Mirrors DB check
 * `invoices_non_draft_has_snapshots` so failures are caught before
 * hitting the DB.
 */
export function assertSnapshotsSet(inv: Invoice): Result<void, InvoiceTransitionError> {
  if (!inv.subtotal) return err({ code: 'missing_snapshot', field: 'subtotal' });
  if (!inv.vatRate) return err({ code: 'missing_snapshot', field: 'vatRate' });
  if (!inv.tenantIdentitySnapshot) return err({ code: 'missing_snapshot', field: 'tenantIdentitySnapshot' });
  if (!inv.memberIdentitySnapshot) return err({ code: 'missing_snapshot', field: 'memberIdentitySnapshot' });
  if (!inv.pdf) return err({ code: 'missing_snapshot', field: 'pdf' });
  return ok(undefined);
}

/**
 * Transition-guard table. Returns ok on legal, err on illegal.
 * Matches data-model.md § 3.1 state machine diagram.
 */
export function canTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  /**
   * 064 — `draft → paid` (as-paid issuance) is legal ONLY for the event
   * subject; membership must always pass `issued` (the §86/4 two-step).
   */
  subject: 'membership' | 'event',
): Result<void, InvoiceTransitionError> {
  if (isTerminal(from)) return err({ code: 'terminal_state', status: from });
  const legal: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
    draft: subject === 'event' ? ['issued', 'paid'] : ['issued'],
    issued: ['paid', 'void'],
    // 088 (data-model.md § 3.1 — `paid --void--> void`; "any non-terminal →
    // void by admin"): voiding a PAID invoice is legal (the void use-case's
    // own guard already accepts `paid`, e.g. a wrongly-recorded offline
    // payment on a membership). Previously omitted here, so routing a
    // paid→void through this table wrongly returned `invalid_transition`.
    paid: ['partially_credited', 'credited', 'void'],
    partially_credited: ['partially_credited', 'credited'],
    void: [],
    credited: [],
  };
  if (!legal[from].includes(to)) return err({ code: 'invalid_transition', from, to });
  return ok(undefined);
}
