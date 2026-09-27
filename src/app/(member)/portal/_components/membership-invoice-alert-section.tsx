import { getLocale } from 'next-intl/server';
import { formatSatangThb } from '@/lib/format-thb';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { formatDueDate } from '../_lib/format-due-date';
import { selectMembershipInvoiceAlert } from '../_lib/membership-invoice-alert';
import { loadDashboardOnlineMethods, loadDashboardOutstanding } from './dashboard-reads';
import { MembershipInvoiceAlert } from './membership-invoice-alert';

/**
 * Spec 122 US3 — the home page's unpaid-membership-invoice alert, in its own
 * Suspense boundary (it reads the cached outstanding rows and the tenant's
 * payment settings). Renders nothing when no membership invoice is unpaid or
 * the outstanding read failed — the Outstanding stat already shows that.
 */
export async function MembershipInvoiceAlertSection({
  tenantId,
  memberId,
}: {
  readonly tenantId: string;
  readonly memberId: string;
}) {
  const read = await loadDashboardOutstanding(tenantId, memberId);
  if (read.error) return null;
  const alert = selectMembershipInvoiceAlert(read.inputs, bangkokLocalDate(new Date().toISOString()));
  if (alert === null) return null;
  const [locale, online] = await Promise.all([getLocale(), loadDashboardOnlineMethods(tenantId)]);
  return (
    <MembershipInvoiceAlert
      invoiceId={alert.id}
      documentNumber={alert.documentNumber}
      amount={formatSatangThb(alert.totalSatang, locale)}
      dueDate={alert.dueDate === null ? null : formatDueDate(alert.dueDate, locale)}
      overdue={alert.overdue}
      online={online}
    />
  );
}
