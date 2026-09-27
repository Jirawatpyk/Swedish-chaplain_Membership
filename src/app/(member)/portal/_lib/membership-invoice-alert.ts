/**
 * Spec 122 US3 (`Main` board) — which invoice the home page's alert names.
 *
 * Pure: it reads the SAME cached outstanding rows the Outstanding stat and the
 * suspended-card CTA use, so the alert costs no extra query. The pick is
 * `findUnpaidMembershipInvoiceId`'s (issued, membership, earliest due), so the
 * alert and the suspended card can never point at different invoices.
 */
import type { OutstandingInvoiceInput } from './dashboard-stats';
import { findUnpaidMembershipInvoiceId } from './suspended-cta';

export interface MembershipInvoiceAlertData {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly totalSatang: bigint;
  /** ISO YYYY-MM-DD, or null. */
  readonly dueDate: string | null;
  readonly overdue: boolean;
}

export function selectMembershipInvoiceAlert(
  invoices: readonly OutstandingInvoiceInput[],
  todayBkk: string,
): MembershipInvoiceAlertData | null {
  const id = findUnpaidMembershipInvoiceId(invoices);
  const invoice = id === null ? undefined : invoices.find((i) => i.id === id);
  if (invoice === undefined || invoice.totalSatang === null) return null;
  return {
    id: invoice.id,
    documentNumber: invoice.documentNumber ?? null,
    totalSatang: invoice.totalSatang,
    dueDate: invoice.dueDate,
    overdue: invoice.dueDate !== null && invoice.dueDate < todayBkk,
  };
}
