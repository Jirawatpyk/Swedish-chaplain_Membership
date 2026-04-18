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
  readonly voidReason?: string | null;
}

export interface PdfRenderResult {
  readonly bytes: Uint8Array;
  readonly sha256: string; // 64-char lowercase hex
}

export interface PdfRenderPort {
  render(input: PdfRenderInput): Promise<PdfRenderResult>;
}
