'use client';

/**
 * F114 — the shared read-only diff (T042): one row per proposed field, the
 * value the member saw next to the proposed value; an address group is ONE
 * row rendered as a block; `(empty)` for null; the tax-affecting marker is
 * icon + TEXT (never colour alone — FR-034); below 640 px each row stacks
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
import {
  BILLING_ADDRESS_LINES,
  REGISTERED_ADDRESS_LINES,
  isAddressGroupKey,
} from '@/modules/members/domain/change-request/proposable-fields';

type ProposedValue = ChangeRequestFieldView['proposed'];

function isAddress(v: ProposedValue): v is Exclude<ProposedValue, string | null> {
  return v !== null && typeof v === 'object';
}

export interface ChangeRequestDiffTableProps {
  readonly fields: readonly ChangeRequestFieldView[];
  /** Show each field's decided outcome (US3 / US4 history). */
  readonly showOutcome?: boolean;
  readonly className?: string;
}

export function ChangeRequestDiffTable({ fields, showOutcome = false, className }: ChangeRequestDiffTableProps) {
  const t = useTranslations('portal.changeRequests.diff');

  function renderValue(key: ChangeRequestFieldView['key'], value: ProposedValue): React.ReactNode {
    if (value === null || value === '') return <span className="text-muted-foreground">{t('empty')}</span>;
    if (isAddress(value) || isAddressGroupKey(key)) {
      const obj = (isAddress(value) ? value : {}) as Readonly<Record<string, string | null>>;
      const lines = key === 'billing_address' ? BILLING_ADDRESS_LINES : REGISTERED_ADDRESS_LINES;
      const present = lines.filter((line) => (obj[line] ?? null) !== null && obj[line] !== '');
      if (present.length === 0) return <span className="text-muted-foreground">{t('empty')}</span>;
      return (
        <dl className="m-0 space-y-0.5">
          {present.map((line) => (
            <div key={line} className="flex gap-2">
              <dt className="shrink-0 text-caption text-muted-foreground">{t(`lines.${line}`)}</dt>
              <dd className="m-0 break-words">{obj[line]}</dd>
            </div>
          ))}
        </dl>
      );
    }
    return <span className="break-words">{value}</span>;
  }

  return (
    <ul className={cn('divide-y divide-border rounded-md border', className)} data-testid="change-request-diff">
      <li className="hidden gap-4 px-3 py-2 text-caption font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]" aria-hidden="true">
        <span>{t('field')}</span>
        <span>{t('current')}</span>
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
            <span className="text-caption text-muted-foreground sm:hidden">{t('current')}: </span>
            {renderValue(f.key, f.seen)}
          </div>
          <div>
            <span className="text-caption text-muted-foreground sm:hidden">{t('proposed')}: </span>
            {renderValue(f.key, f.proposed)}
          </div>
        </li>
      ))}
    </ul>
  );
}
