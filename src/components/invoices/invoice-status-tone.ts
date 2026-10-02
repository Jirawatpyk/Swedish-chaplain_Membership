/**
 * The AURA status-pill tone per invoice status — one map for every invoice
 * list and detail (spec 122 US4 `Invoices` board; US8 Session 2026-10-02):
 * paid ready, issued in progress, overdue blocked, and the rest (draft, void,
 * credited, partially credited) neutral. The pill carries its own icon beside
 * the word, so colour is never the only signal.
 */
import type { StatusTone } from '@jirawatpyk/aura-react/server';
import type { InvoiceStatus } from '@/modules/invoicing';

/** `'overdue'` is display-only, derived from an issued invoice past its due date. */
export type InvoiceDisplayStatus = InvoiceStatus | 'overdue';

export function invoiceStatusTone(status: InvoiceDisplayStatus): StatusTone {
  switch (status) {
    case 'paid':
      return 'ready';
    case 'issued':
      return 'progress';
    case 'overdue':
      return 'blocked';
    default:
      return 'neutral';
  }
}
