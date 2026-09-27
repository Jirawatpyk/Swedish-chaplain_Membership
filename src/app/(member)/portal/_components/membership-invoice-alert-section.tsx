import { getLocale } from 'next-intl/server';
import { formatSatangThb } from '@/lib/format-thb';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { loadMembershipAccess } from '@/lib/load-membership-access';
import { isPortalPathAllowed } from '@/lib/lapsed-portal-scope';
import { formatDueDate } from '../_lib/format-due-date';
import { selectMembershipInvoiceAlert } from '../_lib/membership-invoice-alert';
import { loadDashboardOnlineMethods, loadDashboardOutstanding } from './dashboard-reads';
import { MembershipInvoiceAlert } from './membership-invoice-alert';

/**
 * Spec 122 US3 — the home page's unpaid-membership-invoice alert, in its own
 * Suspense boundary (it reads the cached outstanding rows and the tenant's
 * payment settings). Renders nothing when no membership invoice is unpaid or
 * the outstanding read failed — the Outstanding stat already shows that.
 *
 * Membership access decides what it may offer, by the portal gate's own scope
 * rule (`isPortalPathAllowed`; the request-cached `loadMembershipAccess`
 * writes no audit row, unlike `checkPortalAccess`): a terminated member can
 * open the invoice but not start an online payment, so they get View invoice
 * and no "Pay online" (R9: Pay now used to open a pay sheet that refused
 * them). A suspended — unpaid — member keeps Pay now.
 */
const PAYMENT_INITIATE_PATH = '/api/payments/initiate';
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
  const invoiceHref = `/portal/invoices/${alert.id}`;
  const { access } = await loadMembershipAccess(tenantId, memberId);
  if (!isPortalPathAllowed(access, invoiceHref)) return null;
  const canPayOnline = isPortalPathAllowed(access, PAYMENT_INITIATE_PATH);
  const [locale, online] = await Promise.all([
    getLocale(),
    canPayOnline ? loadDashboardOnlineMethods(tenantId) : Promise.resolve(null),
  ]);
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
