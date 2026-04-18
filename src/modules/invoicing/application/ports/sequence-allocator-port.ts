/**
 * T032 — Sequence allocator port (F4).
 *
 * Protocol (data-model.md § 2.5): advisory xact lock + SELECT FOR UPDATE
 * + upsert + increment. Implementation lives in
 * `infrastructure/adapters/postgres-sequence-allocator.ts` (T041).
 */

import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';

export type DocumentTypeCode = 'invoice' | 'receipt' | 'credit_note';

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
