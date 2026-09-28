'use client';

/**
 * F114 — the staff decision table (US2 AS1–AS4, FR-014, FR-019, FR-020,
 * FR-034; T055). One row per proposed field, an address group as ONE row:
 *
 *   - a labelled checkbox per row, pre-selected = approve, de-select = reject
 *     (Space toggles — AURA Checkbox since 122 US5a), with the row's state in
 *     words beside it ("Will be approved" / "Will be rejected", board
 *     `Admin-change-request`); a `contact_removed` row is inert and can only
 *     be rejected, and every checkbox is disabled when the viewer cannot
 *     decide;
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
import { Checkbox } from '@jirawatpyk/aura-react';
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
    <ul
      className={cn(
        'divide-y divide-[var(--aura-border-default)] rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)]',
        className,
      )}
      data-testid="change-request-decision-table"
    >
      <li
        className="hidden gap-4 px-3 py-2 text-xs font-medium text-[var(--aura-fg-secondary)] sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_9rem]"
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
        //  - no decide permission → `disabled` (out of the tab order; the
        //    page-level read-only notice already explains why);
        //  - a contact_removed row → inert so the row STAYS reachable and its
        //    explanation is announced via aria-describedby.
        // Both cases carry aria-disabled; only the permission case leaves the
        // tab order.
        const inert = undecidable;
        const cannotToggle = !canDecide || inert;
        const approved = selected[f.key] === true;
        return (
          <li
            key={f.key}
            className="grid grid-cols-1 gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_9rem] sm:gap-4"
            data-field-key={f.key}
            data-undecidable={undecidable ? 'contact_removed' : undefined}
          >
            <div className="space-y-1 font-medium">
              <span>{label}</span>
              {f.affectsTaxDocuments ? (
                <span className="flex items-start gap-1 text-xs font-normal text-[var(--aura-status-warning-fg)]">
                  <ReceiptTextIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {t('markers.taxAffecting')}
                    {f.taxHint ? <> — {t(`taxHint.${f.taxHint}`)}</> : null}
                  </span>
                </span>
              ) : null}
              {undecidable ? (
                <span id={`decide-${f.key}-why`} className="flex items-center gap-1 text-xs font-normal text-[var(--aura-fg-danger)]" data-testid="marker-contact-removed">
                  <UserXIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('markers.contactRemoved')}
                </span>
              ) : null}
              {f.alreadyCurrent ? (
                <span className="flex items-center gap-1 text-xs font-normal text-[var(--aura-fg-secondary)]" data-testid="marker-already-current">
                  <InfoIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('markers.alreadyCurrent')}
                </span>
              ) : null}
            </div>
            <div className="space-y-1">
              <span className="text-xs text-[var(--aura-fg-secondary)] sm:sr-only">{tDiff('current')}: </span>
              <ProposedValueDisplay fieldKey={f.key} value={f.current} />
              {f.changedSinceSubmitted ? (
                <div className="rounded-[var(--aura-radius-sm)] border border-[var(--aura-alert-warning-border)] bg-[var(--aura-alert-warning-bg)] p-2 text-xs text-[var(--aura-alert-warning-fg)]" data-testid="marker-changed-since-submitted">
                  <span className="flex items-center gap-1 font-medium">
                    <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t('markers.changedSinceSubmitted')}
                  </span>
                  <div className="mt-1 text-[var(--aura-fg-primary)]">
                    <ProposedValueDisplay fieldKey={f.key} value={f.seen} />
                  </div>
                </div>
              ) : null}
            </div>
            <div>
              <span className="text-xs text-[var(--aura-fg-secondary)] sm:sr-only">{tDiff('proposed')}: </span>
              <ProposedValueDisplay fieldKey={f.key} value={f.proposed} />
            </div>
            {/* The checkbox keeps AURA's 16px box but, as before AURA, takes a
                40×32 hit area (WCAG 2.5.8): its invisible input grows past the box. */}
            <div className="flex items-center gap-2 sm:justify-end [&_.aura-check__input]:-inset-x-3 [&_.aura-check__input]:-inset-y-2">
              {decided ? (
                <span
                  className={cn(
                    'flex items-center gap-1 text-xs',
                    f.outcome === 'approved' ? 'text-[var(--aura-fg-positive)]' : 'text-[var(--aura-fg-danger)]',
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
                      its "contact removed" explanation; the toggle is simply inert
                      (review: UX I4 / I9). AURA Checkbox takes the explanation as
                      its `description` (it sets aria-describedby itself). */}
                  <Checkbox
                    id={`decide-${f.key}`}
                    label={t('approveCheckbox', { field: label })}
                    hideLabel
                    {...(inert ? { description: t('markers.contactRemoved') } : {})}
                    checked={approved}
                    disabled={!canDecide}
                    aria-disabled={cannotToggle || undefined}
                    className={inert ? 'cursor-not-allowed opacity-60' : undefined}
                    onChange={(checked) => {
                      if (inert || !canDecide) return;
                      onToggle(f.key, checked);
                    }}
                    data-testid={`approve-${f.key}`}
                  />
                  {/* The row's state in words (board): the checkbox announces
                      its own state, so this is for sighted users only. */}
                  <span className="text-xs text-[var(--aura-fg-secondary)]" aria-hidden="true">
                    {approved ? t('willApprove') : t('willReject')}
                  </span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
