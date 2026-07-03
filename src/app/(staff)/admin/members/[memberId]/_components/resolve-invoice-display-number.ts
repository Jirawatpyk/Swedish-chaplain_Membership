/**
 * 088-invoice-tax-flow-redesign (T071a / FR-030) — the number to DISPLAY for a
 * member-detail invoice row.
 *
 * Bill-first resolution: an issued 088 ใบแจ้งหนี้ carries its non-§87 SC bill
 * number in `billDocumentNumberRaw` with `documentNumber` (the §87 pair) NULL
 * until payment. Reading `documentNumber` alone would render the "(draft)"
 * placeholder for a REAL issued bill (and for a paid 088 bill too) — the exact
 * FR-030 "document_number-NULL sweep" defect this resolves. Legacy / §87 rows
 * (where `billDocumentNumberRaw` is NULL) fall back to `documentNumber?.raw`.
 * Returns `null` for a true draft (both NULL) so the caller supplies its own
 * placeholder.
 *
 * NOT flag-gated (row-shape-correct): the resolution keys on the row's own
 * columns, so a bill issued while the flag was on still surfaces its SC number
 * if the flag is later flipped off. Mirrors the T069 renewal fix
 * (`load-cycle-detail.ts` / the portal renewal success page).
 *
 * NB the `DocumentNumber` VALUE-OBJECT trap: it has no `toString`, so
 * `String(inv.documentNumber)` yields `'[object Object]'` — always read `.raw`.
 *
 * Pure + framework-free so it is unit-testable in isolation (the surrounding
 * Server Component's async render is not).
 */
import type { Invoice } from '@/modules/invoicing';

export function resolveMemberInvoiceDisplayNumber(
  inv: Pick<Invoice, 'billDocumentNumberRaw' | 'documentNumber'>,
): string | null {
  return inv.billDocumentNumberRaw ?? inv.documentNumber?.raw ?? null;
}
