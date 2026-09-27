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
 * Spec 122 US3: AURA `Table` with `stackBelow="sm"` (AURA 5.8): column
 * headers and a row header per field; below 640 px of its own width each row
 * reads as a card, each value labelled by its column header ("Seen" /
 * "Proposed") in the server HTML, headers kept for screen readers.
 */
import { useTranslations } from 'next-intl';
import { Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
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
    <div className={className} data-testid="change-request-diff">
      <Table stackBelow="sm">
        <THead>
          <Tr>
            <Th className="text-[var(--aura-fg-secondary)]">{t('field')}</Th>
            {/* `seen` is the value AT SUBMISSION, not the live record — the staff
                table shows the live one under `current` (round 5, code #1) */}
            <Th className="text-[var(--aura-fg-secondary)]">{t('seen')}</Th>
            <Th className="text-[var(--aura-fg-secondary)]">{t('proposed')}</Th>
          </Tr>
        </THead>
        <TBody>
          {fields.map((f) => (
            <Tr key={f.key} data-field-key={f.key}>
              <Th scope="row" className="sm:w-[28%]">
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
              </Th>
              <Td>
                <ProposedValueDisplay fieldKey={f.key} value={f.seen} />
              </Td>
              <Td>
                <ProposedValueDisplay fieldKey={f.key} value={f.proposed} />
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
