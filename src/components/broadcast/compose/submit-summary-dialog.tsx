'use client';

/**
 * Spec 122 US12d-3 (T1265) — the confirmation Submit opens on both compose
 * forms (the maintainer, 26 Oct 2026; boards `Proposal-compose-confirm`,
 * `Proposal-admin-compose-confirm`). It sums up what is about to be spent:
 * the subject, the recipients with their count, the allowance it uses and
 * when it goes out. Nothing is sent until Submit for review is pressed here.
 *
 * Presentation only: the caller passes what it already holds and runs its
 * own unchanged submit in `onConfirm`.
 */
import { useLocale, useTranslations } from 'next-intl';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { formatCalendarYear } from '@/lib/format-date-localised';
import { formatScheduledFor } from '../bangkok-datetime';

/**
 * The count the submit summary states: the measured count, or for a custom
 * list the lines entered; `null` while there is no number to state.
 */
export function summaryRecipientCount(
  state: { readonly status: string; readonly count?: number },
  kind: string,
  customLineCount: number,
): number | null {
  if (kind === 'custom') return customLineCount;
  return state.status === 'ready' && typeof state.count === 'number' ? state.count : null;
}

export interface SubmitSummaryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => Promise<void>;
  /** The member's own E-Blast, or staff composing on behalf of `company`. */
  readonly onBehalfOf: { readonly company: string } | null;
  readonly subject: string;
  /** The chosen segment's label ("All members"). */
  readonly segmentLabel: string;
  /** The measured or entered recipient count; `null` while unknown. */
  readonly recipientCount: number | null;
  /** The quota the card shows; `null` when it has not loaded. */
  readonly quota: { readonly remaining: number; readonly quotaYear: number } | null;
  /** ISO-8601 UTC, or `null` for "as soon as it's approved". */
  readonly scheduledFor: string | null;
}

export function SubmitSummaryDialog({
  open,
  onOpenChange,
  onConfirm,
  onBehalfOf,
  subject,
  segmentLabel,
  recipientCount,
  quota,
  scheduledFor,
}: SubmitSummaryDialogProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tProxy = useTranslations('admin.broadcasts.proxySubmitDialog');
  const locale = useLocale();

  const scheduled = formatScheduledFor(scheduledFor, locale);
  const rows: ReadonlyArray<readonly [string, string]> = [
    [t('confirm.subject'), subject],
    [
      t('confirm.recipients'),
      recipientCount === null
        ? segmentLabel
        : t('confirm.recipientsCount', { segment: segmentLabel, count: recipientCount }),
    ],
    ...(quota === null
      ? []
      : ([
          [
            t('confirm.allowance'),
            t(onBehalfOf === null ? 'confirm.allowanceMember' : 'confirm.allowanceProxy', {
              remaining: quota.remaining,
              year: formatCalendarYear(quota.quotaYear, locale),
            }),
          ],
        ] as const)),
    [t('confirm.sending'), scheduled === '' ? t('confirm.sendingNow') : t('confirm.sendingAt', { when: scheduled })],
  ];

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      title={onBehalfOf === null ? t('confirm.title') : tProxy('confirmTitle', { company: onBehalfOf.company })}
      description={t('confirm.note')}
      cancelLabel={t('confirm.keepEditing')}
      confirmLabel={t('button.submit')}
      onConfirm={onConfirm}
    >
      <dl
        data-compose-feature="submit-summary"
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2.5"
      >
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-[var(--aura-fg-secondary)]">{term}</dt>
            <dd className="m-0 font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </ConfirmationDialog>
  );
}
