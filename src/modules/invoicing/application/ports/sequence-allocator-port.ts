/**
 * T032 — Sequence allocator port (F4).
 *
 * Protocol (data-model.md § 2.5): advisory xact lock + SELECT FOR UPDATE
 * + upsert + increment. Implementation lives in
 * `infrastructure/adapters/postgres-sequence-allocator.ts` (T041).
 */

import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';

/**
 * Allocator streams. Each maps to a `document_type` enum value + a row in
 * `tenant_document_sequences` (PK `(tenant, document_type, fiscal_year)`).
 *
 * 088-invoice-tax-flow-redesign (T007) adds two NON-§87 streams — they reuse
 * the SAME advisory-lock / FY / counter machinery as the §87 streams, but the
 * §87 no-gaps assertion is a use-case concern that is deliberately NOT applied
 * to them (a gap is legal):
 *   'bill'        — the pre-payment ใบแจ้งหนี้ number (prefix SC), allocated at
 *                   issue; disjoint from the §87 invoice/receipt streams.
 *   'receipt_105' — the SEPARATE §105 RE register (prefix RE) for
 *                   event-without-TIN receipts, keeping the RC §86/4/§87
 *                   register pure; sequential/tidy but NOT §87-strict.
 */
export type DocumentTypeCode =
  | 'invoice'
  | 'receipt'
  | 'credit_note'
  | 'bill'
  | 'receipt_105';

export interface SequenceAllocatorPort {
  /**
   * Allocate the next sequence number for the given stream INSIDE the
   * caller's transaction. Throws on contention that survives retry
   * (max 3 attempts with exponential backoff).
   */
  allocateNext(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly documentType: DocumentTypeCode;
      readonly fiscalYear: FiscalYear;
    },
  ): Promise<number>;
}
