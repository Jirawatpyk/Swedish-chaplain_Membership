'use client';

/**
 * 106-void-on-reissue follow-up — the admin warning toast for a membership
 * bill that WAS issued while an older unpaid bill for the same member could
 * not be auto-voided (a duplicate is still open).
 *
 * Shared by every admin surface that issues through the renewal bridge — the
 * auto-renewal queue's Issue actions and the member-detail "Renew" dialog —
 * so staff see one message, in their locale, naming the old bill by its
 * printed number with a link to it. Copy comes from the structured
 * `supersede_issues` (`routeSupersedeIssues`), never from server strings.
 *
 * A separate `warning` (not the success toast's description): it asks staff
 * to act. Persistent + `closeButton` for the same reason as the refund-form's
 * waived-VAT toast — it is the only moment staff are told, and a
 * never-dismissing toast needs a keyboard dismiss control (WCAG 2.1.1 /
 * ux-standards §4.2).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
        <ul className="flex flex-col gap-2">
          {issues.map((issue, i) =>
            issue.messageKey === 'voidFailed' ? (
              <li key={issue.invoiceId} className="flex flex-col items-start gap-1">
                <span>{t('voidFailed', { number: issue.number })}</span>
                {/* 44×44 target — same standard as the queue's "View
                    existing bill" link. */}
                <Link
                  href={`/admin/invoices/${issue.invoiceId}`}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'min-h-11 gap-1 px-3',
                  )}
                >
                  {t('openBill', { number: issue.number })}
                </Link>
              </li>
            ) : (
              <li key={`generic-${i}`}>{t('listFailed')}</li>
            ),
          )}
        </ul>
      ),
      duration: Infinity,
      closeButton: true,
    });
  };
}
