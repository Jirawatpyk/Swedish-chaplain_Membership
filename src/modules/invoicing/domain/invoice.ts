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

export interface Invoice {
  readonly tenantId: string;
  readonly invoiceId: InvoiceId;
  readonly memberId: string;
  readonly planId: string;
  readonly planYear: number;

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
   * Receipt PDF metadata — written by record-payment. Separate from
   * `pdf` so the invoice's issue-time hash stays intact for audit.
   * Null on draft/issued; non-null on paid (separate-mode) OR null
   * on paid (combined-mode — no distinct receipt exists, `pdf` is
   * the combined ใบกำกับภาษี/ใบเสร็จรับเงิน).
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

  readonly lines: readonly InvoiceLine[];

  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InvoiceTransitionError =
  | { code: 'invalid_transition'; from: InvoiceStatus; to: InvoiceStatus }
  | { code: 'terminal_state'; status: InvoiceStatus }
  | { code: 'missing_snapshot'; field: string }
  | { code: 'no_membership_line' }
  | { code: 'multiple_membership_lines'; count: number };

export function isTerminal(status: InvoiceStatus): boolean {
  return status === 'void' || status === 'credited';
}

/**
 * Draft invariant: exactly one `membership_fee` line required before
 * issue. Enforced at Application layer on transition to `issued`.
 */
export function enforceOneMembershipLine(lines: readonly InvoiceLine[]): Result<void, InvoiceTransitionError> {
  const count = lines.filter((l) => l.kind === 'membership_fee').length;
  if (count === 0) return err({ code: 'no_membership_line' });
  if (count > 1) return err({ code: 'multiple_membership_lines', count });
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
): Result<void, InvoiceTransitionError> {
  if (isTerminal(from)) return err({ code: 'terminal_state', status: from });
  const legal: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
    draft: ['issued'],
    issued: ['paid', 'void'],
    paid: ['partially_credited', 'credited'],
    partially_credited: ['partially_credited', 'credited'],
    void: [],
    credited: [],
  };
  if (!legal[from].includes(to)) return err({ code: 'invalid_transition', from, to });
  return ok(undefined);
}
