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
 * and the action opens the first bill that still needs a manual void. AURA
 * dismisses a toast when its action runs, so the warning is re-shown under
 * the same id for whatever is left — with several bills, each click opens the
 * next one and nobody loses the list. Links inside a toast are AURA handoff
 * item #53.
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
import { routeSupersedeIssues, type SupersedeIssueCopy } from './supersede-issue-routing';

const TOAST_ID = 'supersede-warning';

export function useSupersedeWarningToast(): (
  body: Parameters<typeof routeSupersedeIssues>[0],
) => void {
  const t = useTranslations('admin.invoices.supersedeWarning');
  const router = useRouter();

  const show = (issues: readonly SupersedeIssueCopy[]): void => {
    if (issues.length === 0) return;
    const lines = issues.map((issue) =>
      issue.messageKey === 'voidFailed' ? t('voidFailed', { number: issue.number }) : t('listFailed'),
    );
    const firstBill = issues.find((issue) => issue.messageKey === 'voidFailed');
    toast.warning(t('title'), {
      id: TOAST_ID,
      description: lines.join(' '),
      ...(firstBill !== undefined && firstBill.messageKey === 'voidFailed'
        ? {
            action: {
              label: t('openBill', { number: firstBill.number }),
              onClick: () => {
                router.push(`/admin/invoices/${firstBill.invoiceId}`);
                const rest = issues.filter((issue) => issue !== firstBill);
                // After AURA's own dismiss, which runs right after this handler.
                if (rest.length > 0) queueMicrotask(() => show(rest));
              },
            },
          }
        : {}),
      duration: Infinity,
      closeButton: true,
    });
  };

  return (body) => show(routeSupersedeIssues(body));
}
