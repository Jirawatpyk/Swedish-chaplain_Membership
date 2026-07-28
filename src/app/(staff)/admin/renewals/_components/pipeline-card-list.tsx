'use client';

/**
 * Task 12 — `PipelineCardList`. Mobile (`≤md`) card-stack presentation
 * for the pipeline table (closes J8-M34, `docs/ux-standards.md` § 9.4).
 *
 * SHARED STATE, NOT A SECOND IMPLEMENTATION — `pipeline-table.tsx` hands
 * this component the SAME `useReactTable` instance it builds for the
 * desktop `<table>` (via the `table` prop), and this component reads
 * rows via `table.getRowModel().rows` + toggles selection via
 * `row.toggleSelected()` — the identical TanStack row API the table's
 * own selection column cell uses. A selection made in card view and one
 * made in table view are therefore the SAME uncontrolled row-selection
 * state; resizing across the `md` breakpoint never loses or duplicates
 * a selection. `onRecordOutreach`/`onMarkPaid` are the SAME
 * `setOutreachFor`/`setMarkPaidFor` setters `pipeline-table.tsx` passes
 * to its own `<RowActions>` cell, so the `OutreachDialog` +
 * `MarkPaidOfflineDialog` already lifted to `PipelineTable`'s root are
 * shared by both presentations — no second dialog pair.
 *
 * `RowActions` is imported UNCHANGED from `pipeline-table.tsx` and
 * rendered once per card — same ⋯ menu, same "Send reminder" button,
 * same `canMutate` gating, same `finalFocus` contract (each `RowActions`
 * instance owns its own trigger ref, exactly as it already does per
 * table row).
 *
 * Card anatomy:
 *   ┌───────────────────────────────────────────┐
 *   │ [ ] Acme Trading Co.            [ t-30 ]   │  selection checkbox (if enabled) · company · urgency pill (text label)
 *   │     Premium                                │  tier badge
 *   │ Expires 1 Dec 2026                         │  CycleExpiresCell
 *   │ ─────────────────────────────────────────  │
 *   │                          [Send reminder] ⋯ │  RowActions (unchanged)
 *   └───────────────────────────────────────────┘
 *
 * a11y: each card is `<div role="group" aria-label={companyName}>` (a
 * `<Card>` under the hood — same visual convention as the sibling
 * `PortalInvoiceCardList`, `060-member-portal-d4`) inside an `<li>` of a
 * plain `<ul>`. The urgency pill's visible TEXT label (not colour alone)
 * carries the meaning (WCAG 1.4.1) — `UrgencyPill` already guarantees
 * this. The selection checkbox reuses the table's OWN
 * `selectRow`/`selectRowGeneric` i18n keys + the `min-h-[24px]
 * min-w-[24px]` sizing (the `Checkbox` primitive's own `::after` hit-area
 * supplies the 44px WCAG 2.5.5 touch target — same review-fixed sizing
 * as the table's selection column).
 */
import type { Table as ReactTableInstance } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { PipelineRow } from '@/modules/renewals/client';
import {
  RowActions,
  PipelineEmptyMessage,
  type OutreachTarget,
  type MarkPaidTarget,
} from './pipeline-table';

export interface PipelineCardListProps {
  /** The SAME `useReactTable` instance `PipelineTable` builds — see the module docstring. */
  readonly table: ReactTableInstance<PipelineRow>;
  readonly canMutate: boolean;
  readonly enableSelection?: boolean;
  readonly onRecordOutreach: (t: OutreachTarget) => void;
  readonly onMarkPaid: (t: MarkPaidTarget) => void;
  /** Month-lens empty-state copy — forwarded verbatim from `PipelineTable`. */
  readonly monthKind?: 'overdue' | 'later' | 'month';
  readonly monthLabel?: string;
  /** The page passes `md:hidden`. */
  readonly className?: string;
}

export function PipelineCardList({
  table,
  canMutate,
  enableSelection = false,
  onRecordOutreach,
  onMarkPaid,
  monthKind,
  monthLabel,
  className,
}: PipelineCardListProps): React.JSX.Element {
  const t = useTranslations('admin.renewals.table');
  const rows = table.getRowModel().rows;

  if (rows.length === 0) {
    return (
      <div
        data-testid="pipeline-card-list"
        className={cn('py-8 text-center text-muted-foreground', className)}
      >
        <PipelineEmptyMessage
          {...(monthKind !== undefined ? { monthKind } : {})}
          {...(monthLabel !== undefined ? { monthLabel } : {})}
        />
      </div>
    );
  }

  return (
    <ul
      role="list"
      data-testid="pipeline-card-list"
      className={cn('flex flex-col gap-3', className)}
    >
      {rows.map((row) => {
        const original = row.original;
        const companyDisplay = original.companyName || t('unknownCompany');
        return (
          <li key={row.id}>
            <Card
              role="group"
              aria-label={companyDisplay}
              data-state={row.getIsSelected() ? 'selected' : undefined}
              className="data-[state=selected]:bg-muted"
            >
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    {enableSelection ? (
                      <Checkbox
                        checked={row.getIsSelected()}
                        onCheckedChange={(checked: boolean) =>
                          row.toggleSelected(!!checked)
                        }
                        // Review fix M-3 precedent (table selection column) —
                        // fall back to the generic label when companyName is
                        // empty rather than interpolate a dangling "Select ".
                        aria-label={
                          original.companyName
                            ? t('selectRow', { company: original.companyName })
                            : t('selectRowGeneric')
                        }
                        className="mt-1 min-h-[24px] min-w-[24px]"
                      />
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-1">
                      <CycleCompanyCell
                        memberId={original.memberId}
                        companyName={original.companyName}
                        emailUnverified={original.emailUnverified}
                      />
                      <CycleTierCell tier={original.tierBucket} />
                    </div>
                  </div>
                  <UrgencyPill urgency={original.urgency} className="shrink-0" />
                </div>
                <CycleExpiresCell expiresAt={original.expiresAt} />
                <div className="flex justify-end">
                  <RowActions
                    cycleId={original.cycleId}
                    memberId={original.memberId}
                    companyName={original.companyName}
                    status={original.status}
                    canMutate={canMutate}
                    onRecordOutreach={onRecordOutreach}
                    onMarkPaid={onMarkPaid}
                  />
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
