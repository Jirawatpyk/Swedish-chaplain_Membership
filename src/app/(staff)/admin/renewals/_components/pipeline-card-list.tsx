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
 * `RowActions` + `PipelineEmptyMessage` are imported UNCHANGED from the
 * sibling `./row-actions` module (review round 1, FIX 1 — moved out of
 * `pipeline-table.tsx` to break a 2-module import cycle: this file used
 * to import them FROM `pipeline-table.tsx`, which itself imports
 * `PipelineCardList` FROM this file. See `row-actions.tsx`'s module
 * docstring). `RowActions` is rendered once per card — same ⋯ menu, same
 * "Send reminder" button, same `canMutate` gating, same `finalFocus`
 * contract (each `RowActions` instance owns its own trigger ref, exactly
 * as it already does per table row).
 *
 * Card anatomy — review round 1 (FIX 2 / I-1) restored the three fields
 * the table shows but the card previously dropped (status, last reminder,
 * linked invoice), reusing the SAME JSX/i18n keys as the table's own
 * `status`/`last_reminder`/`invoice` column cells (`pipeline-table.tsx`):
 *   ┌───────────────────────────────────────────┐
 *   │ [ ] Acme Trading Co.            [ t-30 ]   │  selection checkbox (if enabled) · company · urgency pill (text label)
 *   │     Premium                                │  tier badge
 *   │ Expires 1 Dec 2026                         │  CycleExpiresCell (FIX 3 — now labelled, see below)
 *   │ Status Upcoming                            │  status cell, labelled inline (same pattern as PortalInvoiceCardList)
 *   │ Last reminder 5 minutes ago                │  RelativeTime, or — when null
 *   │ Invoice View invoice / Covered / —         │  linked-invoice link, "Covered" label + sr-only reason, or —
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
 * min-w-[24px]` sizing — a 24px visible box (WCAG 2.5.8 AA floor) whose
 * `Checkbox` primitive `::after` hit-area extends it to ~48×40px, well
 * past the 24px minimum (2.5.5's 44px target is AAA, not this project's
 * bar) — same review-fixed sizing as the table's selection column.
 *
 * FIX 3 (I-2, WCAG 1.3.1) — `CycleExpiresCell` now takes an optional
 * `label` prop; the card passes `columns.expires` ("Expires") so the date
 * carries a visible label here (the table still gets no label — that
 * meaning comes from its `<th>` — see `cycle-cells.tsx`).
 *
 * FIX 4a (M-3) — the company-name `<Link>` gets `truncate` (via
 * `CycleCompanyCell`'s new `linkClassName` prop) so a long single-word
 * name ellipsizes instead of hard-clipping against the card's bounded
 * width.
 */
import Link from 'next/link';
import type { Table as ReactTableInstance } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import { RelativeTime } from '@/components/ui/relative-time';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { CycleStatus, PipelineRow } from '@/modules/renewals/client';
import {
  RowActions,
  PipelineEmptyMessage,
  type OutreachTarget,
  type MarkPaidTarget,
} from './row-actions';

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

  // Task 12 review round 1 (FIX 4b) — ONE persistent landmark div always
  // carries `data-testid="pipeline-card-list"`, regardless of empty vs
  // populated state (previously the empty-state `<div>` and the populated
  // `<ul>` were TWO DIFFERENT elements that each separately carried this
  // testid, which read as ambiguous even though only one ever renders at a
  // time). The `<ul role="list">` of cards nests INSIDE this div when
  // populated, so `getByTestId('pipeline-card-list').getByRole('group')`
  // (the existing E2E query shape) keeps resolving unchanged either way.
  return (
    <div data-testid="pipeline-card-list" className={className}>
      {rows.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          <PipelineEmptyMessage
            {...(monthKind !== undefined ? { monthKind } : {})}
            {...(monthLabel !== undefined ? { monthLabel } : {})}
          />
        </div>
      ) : (
        <ul role="list" className="flex flex-col gap-3">
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
                          {/* FIX 4a (M-3) — `truncate` so a long single-word
                              company name ellipsizes instead of hard-clipping
                              against the card's bounded width. */}
                          <CycleCompanyCell
                            memberId={original.memberId}
                            companyName={original.companyName}
                            emailUnverified={original.emailUnverified}
                            linkClassName="truncate"
                          />
                          <CycleTierCell tier={original.tierBucket} />
                        </div>
                      </div>
                      <UrgencyPill urgency={original.urgency} className="shrink-0" />
                    </div>
                    {/* FIX 3 (I-2, WCAG 1.3.1) — the table's "Expires" meaning
                        comes from its `<th>`; a card has no such header
                        association, so pass the same `columns.expires` label
                        the table uses, giving the date a visible label here. */}
                    <CycleExpiresCell
                      expiresAt={original.expiresAt}
                      label={t('columns.expires')}
                    />
                    {/* FIX 2 (I-1 parity) — status/last-reminder/invoice,
                        restored verbatim from the table's own column cells
                        (`pipeline-table.tsx`'s `status`/`last_reminder`/
                        `invoice` columns), each prefixed with its existing
                        column label — same inline-label pattern the sibling
                        `PortalInvoiceCardList` uses for its "Dates" line.
                        speckit-review #6 — the three near-identical label+value
                        `<p>` blocks now share the `LabeledRow` helper (below);
                        rendered output is unchanged. */}
                    <LabeledRow label={t('columns.status')}>
                      {t(`status.${original.status}` as `status.${CycleStatus}`)}
                    </LabeledRow>
                    <LabeledRow label={t('columns.lastReminder')}>
                      {original.lastReminderAt ? (
                        <RelativeTime
                          iso={original.lastReminderAt}
                          className="tabular-nums"
                        />
                      ) : (
                        '—'
                      )}
                    </LabeledRow>
                    <LabeledRow label={t('columns.invoice')}>
                      {original.linkedInvoiceId ? (
                        <Link
                          href={`/admin/invoices/${original.linkedInvoiceId}`}
                          className="text-primary hover:underline"
                        >
                          {t('viewInvoice')}
                        </Link>
                      ) : original.anchored ? (
                        // Same "Covered" coverage-language treatment as the
                        // table's invoice cell — `title` for sighted mouse
                        // users, the `sr-only` span exposes the SAME reason
                        // to keyboard/touch/screen-reader users (WCAG 1.4.1;
                        // text label, not colour alone, carries the meaning).
                        <span
                          className="font-medium text-success"
                          title={t('invoiceCoveredTitle')}
                        >
                          {t('invoiceCoveredLabel')}
                          <span className="sr-only"> — {t('invoiceCoveredTitle')}</span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </LabeledRow>
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
      )}
    </div>
  );
}

/**
 * speckit-review #6 — the card's status / last-reminder / invoice rows were
 * three near-identical hand-rolled label+value `<p>` blocks. This extracts
 * the shared `text-sm text-muted-foreground` `<p>` with an inline label; the
 * rendered output — the label, one space, then the value node — is identical
 * to the previous inline blocks (`{label}{' '}{value}`). Pure markup DRY.
 */
function LabeledRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="text-sm text-muted-foreground">
      {label} {children}
    </p>
  );
}
