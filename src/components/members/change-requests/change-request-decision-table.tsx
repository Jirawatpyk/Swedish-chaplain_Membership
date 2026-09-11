'use client';

/**
 * F114 — the staff decision table (US2 AS1–AS4, FR-014, FR-019, FR-020,
 * FR-034; T055). One row per proposed field, an address group as ONE row:
 *
 *   - a labelled checkbox per row, pre-selected = approve, de-select = reject
 *     (Space toggles — Base UI Checkbox); the checkbox is DISABLED (and
 *     `aria-disabled`) for a `contact_removed` row, which can only be
 *     rejected, and for every row when the viewer cannot decide;
 *   - three-value display when `changedSinceSubmitted`: what the member saw,
 *     what is current now, what is proposed — the current value is what the
 *     decision overwrites;
 *   - "already current" (approve = a recorded no-op) and "contact removed"
 *     markers as text; the tax flag as icon + text with the `taxHint` copy
 *     (never colour alone);
 *   - below 640 px each row stacks into a card.
 */
import { useTranslations } from 'next-intl';
import { AlertTriangleIcon, CheckIcon, InfoIcon, ReceiptTextIcon, UserXIcon, XIcon } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { ChangeRequestReviewFieldView } from '@/lib/change-request-staff-view';
import { ProposedValueDisplay } from './proposed-value-display';

export interface ChangeRequestDecisionTableProps {
  readonly fields: readonly ChangeRequestReviewFieldView[];
  /** key → approved (true) / rejected (false). Ignored when the request is decided (outcomes shown instead). */
  readonly selected: Readonly<Record<string, boolean>>;
  readonly onToggle: (key: string, approved: boolean) => void;
  /** false → checkboxes disabled (manager, archived, erasing, not pending). */
  readonly canDecide: boolean;
  /** true → the request is decided: show each row's recorded outcome instead of a checkbox. */
  readonly decided: boolean;
  readonly className?: string;
}

export function ChangeRequestDecisionTable({ fields, selected, onToggle, canDecide, decided, className }: ChangeRequestDecisionTableProps) {
  const t = useTranslations('admin.changeRequests.review');
  const tDiff = useTranslations('portal.changeRequests.diff');

  return (
    <ul className={cn('divide-y divide-border rounded-md border', className)} data-testid="change-request-decision-table">
      <li
        className="hidden gap-4 px-3 py-2 text-caption font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_5rem]"
        aria-hidden="true"
      >
        <span>{tDiff('field')}</span>
        <span>{tDiff('current')}</span>
        <span>{tDiff('proposed')}</span>
        <span className="text-right">{t('columns.decision')}</span>
      </li>
      {fields.map((f) => {
        const label = tDiff(`labels.${f.key}`);
        const undecidable = f.undecidable === 'contact_removed';
        // Two different "cannot toggle" cases (round 2, UX + a11y):
        //  - no decide permission → a NATIVE disabled control (out of the tab
        //    order; the page-level read-only notice already explains why);
        //  - a contact_removed row → `aria-disabled` + inert so the row STAYS
        //    reachable and its explanation is announced via aria-describedby.
        const inert = undecidable;
        const approved = selected[f.key] === true;
        return (
          <li
            key={f.key}
            className="grid grid-cols-1 gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_5rem] sm:gap-4"
            data-field-key={f.key}
            data-undecidable={undecidable ? 'contact_removed' : undefined}
          >
            <div className="space-y-1 font-medium">
              <span>{label}</span>
              {f.affectsTaxDocuments ? (
                <span className="flex items-start gap-1 text-caption font-normal text-amber-800 dark:text-amber-300">
                  <ReceiptTextIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {t('markers.taxAffecting')}
                    {f.taxHint ? <> — {t(`taxHint.${f.taxHint}`)}</> : null}
                  </span>
                </span>
              ) : null}
              {undecidable ? (
                <span id={`decide-${f.key}-why`} className="flex items-center gap-1 text-caption font-normal text-destructive" data-testid="marker-contact-removed">
                  <UserXIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('markers.contactRemoved')}
                </span>
              ) : null}
              {f.alreadyCurrent ? (
                <span className="flex items-center gap-1 text-caption font-normal text-muted-foreground" data-testid="marker-already-current">
                  <InfoIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('markers.alreadyCurrent')}
                </span>
              ) : null}
            </div>
            <div className="space-y-1">
              <span className="text-caption text-muted-foreground sm:sr-only">{tDiff('current')}: </span>
              <ProposedValueDisplay fieldKey={f.key} value={f.current} />
              {f.changedSinceSubmitted ? (
                <div className="rounded-sm border border-amber-300/60 bg-amber-50 p-2 text-caption text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200" data-testid="marker-changed-since-submitted">
                  <span className="flex items-center gap-1 font-medium">
                    <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t('markers.changedSinceSubmitted')}
                  </span>
                  <div className="mt-1 text-foreground">
                    <ProposedValueDisplay fieldKey={f.key} value={f.seen} />
                  </div>
                </div>
              ) : null}
            </div>
            <div>
              <span className="text-caption text-muted-foreground sm:sr-only">{tDiff('proposed')}: </span>
              <ProposedValueDisplay fieldKey={f.key} value={f.proposed} />
            </div>
            <div className="flex items-center gap-2 sm:justify-end">
              {decided ? (
                <span
                  className={cn(
                    'flex items-center gap-1 text-caption',
                    f.outcome === 'approved' ? 'text-emerald-800 dark:text-emerald-300' : 'text-destructive',
                  )}
                  data-testid={`outcome-${f.key}`}
                >
                  {f.outcome === 'approved' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <XIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                  {f.outcome ? tDiff(`outcome.${f.outcome}`) : null}
                </span>
              ) : (
                <>
                  {/* `aria-disabled` (not `disabled`): a reject-only row stays in the
                      tab order so a keyboard / screen-reader user reaches the row AND
                      its "contact removed" explanation (`aria-describedby`); the
                      toggle is simply inert. The visible caption is aria-hidden so the
                      accessible name is announced once (review: UX I4 / I9). */}
                  <Checkbox
                    id={`decide-${f.key}`}
                    aria-label={t('approveCheckbox', { field: label })}
                    aria-describedby={inert ? `decide-${f.key}-why` : undefined}
                    checked={approved}
                    disabled={!canDecide}
                    aria-disabled={inert || undefined}
                    className={inert ? 'cursor-not-allowed border-muted-foreground/40 bg-muted' : undefined}
                    onCheckedChange={(c) => {
                      if (inert || !canDecide) return;
                      onToggle(f.key, c === true);
                    }}
                    data-testid={`approve-${f.key}`}
                  />
                  <span className="text-caption text-muted-foreground sm:hidden" aria-hidden="true">{t('approveCheckbox', { field: label })}</span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
