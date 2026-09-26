'use client';

/**
 * 106-void-on-reissue follow-up — the admin warning toast for a membership
 * bill that WAS issued while an older unpaid bill for the same member could
 * not be auto-voided (a duplicate is still open).
 *
 * Shared by every admin surface that issues through the renewal bridge — the
 * auto-renewal queue's Issue actions and the member-detail "Renew" dialog —
 * so staff see one message, in their locale, naming the old bill by its
 * printed number, with a link to each bill. Copy comes from the
 * structured `supersede_issues` (`routeSupersedeIssues`), never from server
 * strings.
 *
 * Each issue is one line; a bill that still needs a manual void carries its
 * own "Open bill …" `next/link` (AURA 5.6 rich toast description, handoff
 * #53), so with several bills staff can open each one without losing the
 * others.
 *
 * A separate `warning` (not the success toast's description): it asks staff
 * to act. Persistent + `closeButton` for the same reason as the refund-form's
 * waived-VAT toast — it is the only moment staff are told, and a
 * never-dismissing toast needs a keyboard dismiss control (WCAG 2.1.1 /
 * ux-standards §4.2).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { routeSupersedeIssues } from './supersede-issue-routing';

export function useSupersedeWarningToast(): (
  body: Parameters<typeof routeSupersedeIssues>[0],
) => void {
  const t = useTranslations('admin.invoices.supersedeWarning');

  return (body) => {
    const issues = routeSupersedeIssues(body);
    if (issues.length === 0) return;
    toast.warning(t('title'), {
      description: (
        <ul className="flex flex-col gap-1">
          {issues.map((issue, index) =>
            issue.messageKey === 'voidFailed' ? (
              <li key={issue.invoiceId}>
                {t('voidFailed', { number: issue.number })}{' '}
                <Link href={`/admin/invoices/${issue.invoiceId}`} className="underline underline-offset-2">
                  {t('openBill', { number: issue.number })}
                </Link>
              </li>
            ) : (
              <li key={`list-failed-${index}`}>{t('listFailed')}</li>
            ),
          )}
        </ul>
      ),
      duration: Infinity,
      closeButton: true,
    });
  };
}
