'use client';

/**
 * 106-void-on-reissue follow-up — the admin warning toast for a membership
 * bill that WAS issued while an older unpaid bill for the same member could
 * not be auto-voided (a duplicate is still open).
 *
 * Shared by every admin surface that issues through the renewal bridge — the
 * auto-renewal queue's Issue actions and the member-detail "Renew" dialog —
 * so staff see one message, in their locale, naming the old bill by its
 * printed number, with one action that opens it. Copy comes from the
 * structured `supersede_issues` (`routeSupersedeIssues`), never from server
 * strings.
 *
 * Plain text + ONE action (spec 122 research R4): the toast API takes a
 * string description and a single action, so every issue becomes a sentence
 * and the action opens the first bill that still needs a manual void — each
 * sentence names its own bill number, so staff can find the others from
 * there. Links inside a toast are AURA handoff item #53.
 *
 * A separate `warning` (not the success toast's description): it asks staff
 * to act. Persistent + `closeButton` for the same reason as the refund-form's
 * waived-VAT toast — it is the only moment staff are told, and a
 * never-dismissing toast needs a keyboard dismiss control (WCAG 2.1.1 /
 * ux-standards §4.2).
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { routeSupersedeIssues } from './supersede-issue-routing';

export function useSupersedeWarningToast(): (
  body: Parameters<typeof routeSupersedeIssues>[0],
) => void {
  const t = useTranslations('admin.invoices.supersedeWarning');
  const router = useRouter();

  return (body) => {
    const issues = routeSupersedeIssues(body);
    if (issues.length === 0) return;
    const lines = issues.map((issue) =>
      issue.messageKey === 'voidFailed' ? t('voidFailed', { number: issue.number }) : t('listFailed'),
    );
    const firstBill = issues.find((issue) => issue.messageKey === 'voidFailed');
    toast.warning(t('title'), {
      description: lines.join(' '),
      ...(firstBill !== undefined && firstBill.messageKey === 'voidFailed'
        ? {
            action: {
              label: t('openBill', { number: firstBill.number }),
              onClick: () => router.push(`/admin/invoices/${firstBill.invoiceId}`),
            },
          }
        : {}),
      duration: Infinity,
      closeButton: true,
    });
  };
}
