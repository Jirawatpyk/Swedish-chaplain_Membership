/**
 * T032 — PDF render port (F4).
 *
 * Adapter wraps `@react-pdf/renderer` + Sarabun font registration.
 * Rendering MUST be deterministic (SC-003 byte-identical re-render).
 */

import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

export type PdfDocKind =
  | 'invoice'
  | 'invoice_preview'
  | 'receipt_combined'
  | 'receipt_separate'
  | 'credit_note'
  | 'void_stamped_invoice';

export interface PdfRenderInput {
  readonly kind: PdfDocKind;
  readonly templateVersion: number;
  readonly documentNumber: DocumentNumber | null; // null for preview
  readonly issueDate: string | null;               // null for preview
  readonly dueDate: string | null;
  readonly tenant: TenantIdentitySnapshot;
  readonly member: MemberIdentitySnapshot;
  readonly lines: readonly InvoiceLine[];
  readonly subtotal: Money;
  readonly vatRate: VatRate;
  readonly vat: Money;
  readonly total: Money;
  /**
   * 054-event-fee-invoices — whether the document's amounts are VAT-INCLUSIVE
   * (event Model B): the line totals carry the all-in (gross) ticket price and
   * `subtotal`/`vat` are the back-calculated split. When true, the template
   * renders a "ราคารวมภาษีมูลค่าเพิ่มแล้ว / VAT included" annotation near the
   * totals so a Thai reader understands the line amount is gross while the
   * subtotal is net. Membership invoices are VAT-EXCLUSIVE (`false`/omitted):
   * the line amounts are net and VAT is added on top. Optional so existing
   * callers (credit-note, void, preview, receipt re-render) default to
   * exclusive without change.
   */
  readonly vatInclusive?: boolean;
  readonly voidReason?: string | null;
  /**
   * T078/T079 — credit-note-specific context. Required when
   * `kind === 'credit_note'`; ignored otherwise. Carries the reference
   * to the original invoice so the template can render the required
   * "in reference to invoice #… dated …" block (Thai RD ใบลดหนี้
   * content requirement).
   */
  readonly creditNote?: {
    readonly originalDocumentNumber: string;
    readonly originalIssueDate: string;
    readonly reason: string;
  } | null;
  /**
   * US6 AS4 — credited-invoice annotation. Rendered on INVOICE kind
   * when the parent row has transitioned to `partially_credited` or
   * `credited`. Adds a diagonal "CREDITED / ลดหนี้แล้ว" (or
   * "PARTIALLY CREDITED / ลดหนี้บางส่วน") overlay + a footer table
   * listing the referencing credit-note numbers + dates + totals.
   * Non-destructive: does NOT remove or obscure the original invoice
   * content (Thai RD legal continuity).
   */
  readonly creditedAnnotation?: {
    readonly fullyCredited: boolean;
    readonly references: ReadonlyArray<{
      readonly documentNumber: string;
      readonly issueDate: string;
      readonly total: Money;
    }>;
  } | null;
  /**
   * Tenant logo bytes — render-time-only (NOT persisted on the
   * invoice snapshot). When set, the template renders the logo above
   * the tenant identity block. Loaded from Blob by `loadTenantLogo`
   * using the `logo_blob_key` from the tenant identity snapshot.
   *
   * Determinism: bytes are stable (immutable Blob object) → same input
   * → same seed → byte-identical re-render. The deterministic-render
   * replacer hashes Uint8Array values to keep the seed-input compact.
   */
  readonly tenantLogo?: {
    readonly bytes: Uint8Array;
    readonly format: 'png' | 'jpg';
  } | null;
}

export interface PdfRenderResult {
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Hex;
}

export interface PdfRenderPort {
  render(input: PdfRenderInput): Promise<PdfRenderResult>;
}
