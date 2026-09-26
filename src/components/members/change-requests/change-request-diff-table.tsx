'use client';

/**
 * F114 — the shared read-only diff (T042): one row per proposed field, the
 * value the member saw next to the proposed value, each rendered by
 * `ProposedValueDisplay` (the one value-rendering rule — an address group is
 * ONE row rendered as a block, `(empty)` for null); the tax-affecting marker
 * is icon + TEXT (never colour alone — FR-034); below 640 px each row stacks
 * into a card (`grid-cols-1` → `sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]`).
 *
 * Used by the portal pending banner (US1), the decision banner + history
 * (US3/US4) and the staff record section (US4). Staff's decision table is a
 * separate component (checkboxes + three-value display).
 *
 * Spec 122 US3: AURA table markup (`aura-tbl` — column headers, a row header
 * per field). AURA's table does not stack, so below 640 px the table, body,
 * rows and cells drop to blocks and each row reads as a card with its own
 * "Seen" / "Proposed" labels, as before.
 */
import { useTranslations } from 'next-intl';
import { ReceiptTextIcon, CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChangeRequestFieldView } from '@/lib/change-request-portal-view';
import { ProposedValueDisplay } from './proposed-value-display';

export interface ChangeRequestDiffTableProps {
  readonly fields: readonly ChangeRequestFieldView[];
  /** Show each field's decided outcome (US3 / US4 history). */
  readonly showOutcome?: boolean;
  readonly className?: string;
}

export function ChangeRequestDiffTable({ fields, showOutcome = false, className }: ChangeRequestDiffTableProps) {
  const t = useTranslations('portal.changeRequests.diff');

  // below `sm` every cell is a block: no AURA cell padding or separators there
  const cell = 'max-sm:block max-sm:border-0 max-sm:p-0';
  return (
    <div
      className={cn(
        'aura-tbl-wrap overflow-hidden rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]',
        className,
      )}
      data-testid="change-request-diff"
    >
      <table className="aura-tbl max-sm:block">
        <thead className="aura-tbl__head max-sm:hidden">
          <tr className="aura-tbl__row">
            <th scope="col" className="aura-tbl__th text-[var(--aura-fg-secondary)]">{t('field')}</th>
            {/* `seen` is the value AT SUBMISSION, not the live record — the staff
                table shows the live one under `current` (round 5, code #1) */}
            <th scope="col" className="aura-tbl__th text-[var(--aura-fg-secondary)]">{t('seen')}</th>
            <th scope="col" className="aura-tbl__th text-[var(--aura-fg-secondary)]">{t('proposed')}</th>
          </tr>
        </thead>
        <tbody className="aura-tbl__body max-sm:block max-sm:divide-y max-sm:divide-[var(--aura-border-default)]">
          {fields.map((f) => (
            <tr key={f.key} className="aura-tbl__row max-sm:flex max-sm:flex-col max-sm:gap-2 max-sm:p-3" data-field-key={f.key}>
              <th scope="row" className={cn('aura-tbl__th sm:w-[28%]', cell)}>
                <span>{t(`labels.${f.key}`)}</span>
                {f.affectsTaxDocuments ? (
                  <span className="mt-1 flex items-center gap-1 text-xs font-normal text-[var(--aura-alert-warning-fg)]">
                    <ReceiptTextIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('taxAffecting')}
                  </span>
                ) : null}
                {showOutcome && f.outcome ? (
                  <span
                    className={cn(
                      'mt-1 flex items-center gap-1 text-xs font-normal',
                      f.outcome === 'approved' ? 'text-[var(--aura-fg-positive)]' : 'text-[var(--aura-fg-danger)]',
                    )}
                  >
                    {f.outcome === 'approved' ? (
                      <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {t(`outcome.${f.outcome}`)}
                  </span>
                ) : null}
              </th>
              <td className={cn('aura-tbl__td', cell)}>
                <span className="text-xs text-[var(--aura-fg-secondary)] sm:sr-only">{t('seen')}: </span>
                <ProposedValueDisplay fieldKey={f.key} value={f.seen} />
              </td>
              <td className={cn('aura-tbl__td', cell)}>
                <span className="text-xs text-[var(--aura-fg-secondary)] sm:sr-only">{t('proposed')}: </span>
                <ProposedValueDisplay fieldKey={f.key} value={f.proposed} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
