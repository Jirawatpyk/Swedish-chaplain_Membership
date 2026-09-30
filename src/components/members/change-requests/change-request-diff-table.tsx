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
 *
 * `variant="plain"` is the portal boards' table (`Portal-profile`,
 * `Portal-change-requests`): AURA's frameless table (`bordered={false}`,
 * 5.13, handoff #81) with the first column flush with the text, the
 * submitted value in the secondary colour, the tax marker as an outline chip
 * beside the field name, an address on one line and each decided field's
 * outcome as a pill in a Decision column. Row padding, header style and the
 * stacked phone labels are AURA's own (parity rule). The staff record
 * section keeps the boxed table.
 */
import { useTranslations } from 'next-intl';
import { Badge, StatusPill, Table, TBody, THead, Td, Th, Tr } from '@jirawatpyk/aura-react';
import { ReceiptTextIcon, CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChangeRequestFieldView } from '@/lib/change-request-portal-view';
import { ProposedValueDisplay } from './proposed-value-display';

export interface ChangeRequestDiffTableProps {
  readonly fields: readonly ChangeRequestFieldView[];
  /** Show each field's decided outcome (US3 / US4 history). */
  readonly showOutcome?: boolean;
  /** `plain` — the member portal's boards; `boxed` (default) — the staff record section. */
  readonly variant?: 'boxed' | 'plain';
  readonly className?: string;
}

export function ChangeRequestDiffTable({ fields, showOutcome = false, variant = 'boxed', className }: ChangeRequestDiffTableProps) {
  const t = useTranslations('portal.changeRequests.diff');
  if (variant === 'plain') return <PlainDiffTable fields={fields} showOutcome={showOutcome} className={className} />;

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

function PlainDiffTable({
  fields,
  showOutcome,
  className,
}: {
  readonly fields: readonly ChangeRequestFieldView[];
  readonly showOutcome: boolean;
  readonly className?: string | undefined;
}) {
  const t = useTranslations('portal.changeRequests.diff');
  const decided = showOutcome && fields.some((f) => f.outcome);
  return (
    <div className={className} data-testid="change-request-diff">
      <Table stackBelow="sm" bordered={false}>
        <THead>
          <Tr>
            <Th>{t('field')}</Th>
            <Th>{t('seen')}</Th>
            <Th>{t('proposed')}</Th>
            {decided ? <Th>{t('decision')}</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {fields.map((f) => (
            <Tr key={f.key} data-field-key={f.key}>
              <Th scope="row" className="sm:w-[26%]">
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span>{t(`labels.${f.key}`)}</span>
                  {/* Still text, never colour alone (FR-034). */}
                  {f.affectsTaxDocuments ? <Badge variant="outline">{t('taxAffecting')}</Badge> : null}
                  {/* The phone boards put the outcome beside the name. */}
                  {decided && f.outcome ? (
                    <span className="sm:hidden">
                      <StatusPill tone={f.outcome === 'approved' ? 'ready' : 'blocked'}>{t(`outcome.${f.outcome}`)}</StatusPill>
                    </span>
                  ) : null}
                </span>
              </Th>
              <Td label={t('wasShort')} className="text-[var(--aura-fg-secondary)]">
                <ProposedValueDisplay fieldKey={f.key} value={f.seen} inline />
              </Td>
              <Td label={t('proposed')}>
                <ProposedValueDisplay fieldKey={f.key} value={f.proposed} inline />
              </Td>
              {decided ? (
                <Td className="max-sm:hidden">
                  {f.outcome ? (
                    <StatusPill tone={f.outcome === 'approved' ? 'ready' : 'blocked'}>{t(`outcome.${f.outcome}`)}</StatusPill>
                  ) : null}
                </Td>
              ) : null}
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
