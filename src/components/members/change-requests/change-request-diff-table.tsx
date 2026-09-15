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

  return (
    <ul className={cn('divide-y divide-border rounded-md border', className)} data-testid="change-request-diff">
      <li className="hidden gap-4 px-3 py-2 text-caption font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]" aria-hidden="true">
        <span>{t('field')}</span>
        {/* `seen` is the value AT SUBMISSION, not the live record — the staff
            table shows the live one under `current` (round 5, code #1) */}
        <span>{t('seen')}</span>
        <span>{t('proposed')}</span>
      </li>
      {fields.map((f) => (
        <li
          key={f.key}
          className="grid grid-cols-1 gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] sm:gap-4"
          data-field-key={f.key}
        >
          <div className="font-medium">
            <span>{t(`labels.${f.key}`)}</span>
            {f.affectsTaxDocuments ? (
              <span className="mt-1 flex items-center gap-1 text-caption font-normal text-amber-800 dark:text-amber-300">
                <ReceiptTextIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {t('taxAffecting')}
              </span>
            ) : null}
            {showOutcome && f.outcome ? (
              <span
                className={cn(
                  'mt-1 flex items-center gap-1 text-caption font-normal',
                  f.outcome === 'approved' ? 'text-emerald-800 dark:text-emerald-300' : 'text-destructive',
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
          </div>
          <div>
            <span className="text-caption text-muted-foreground sm:sr-only">{t('seen')}: </span>
            <ProposedValueDisplay fieldKey={f.key} value={f.seen} />
          </div>
          <div>
            <span className="text-caption text-muted-foreground sm:sr-only">{t('proposed')}: </span>
            <ProposedValueDisplay fieldKey={f.key} value={f.proposed} />
          </div>
        </li>
      ))}
    </ul>
  );
}
