/**
 * F119 walk U37 — phone card list for the member's E-Blast history.
 *
 * Server Component. Below `md` the five-column history table was a 729 px
 * table in a 209 px scroll box at 320 px, so Status / Audience / Submitted /
 * Sent were reachable only by swiping a nested region. `BroadcastsPanel`
 * now dual-renders — the table inside `hidden md:block`, this list with
 * `md:hidden` — the pattern `/portal/invoices` uses
 * (`portal-invoice-card-list.tsx`) and the admin queue uses
 * (`queue-card-list.tsx`).
 *
 * SINGLE SOURCE OF TRUTH — both representations consume the SAME
 * pre-formatted {@link BroadcastHistoryRowView} the panel builds once, so the
 * status label, audience count and dates can never drift between them.
 *
 * a11y: `<ul role="list">` (Safari drops list semantics under
 * `list-style: none`) of `<li>`, each holding one link named by its row
 * (subject, then status) for an at-a-glance summary; the status is badge
 * TEXT (WCAG 1.4.1); the table's column headers become visible labels, since
 * a row has no `<th>`.
 *
 * Spec 122 US12d-1 (T1236, board `Portal-broadcasts-mobile`): one bordered
 * list; each row is a link filling the row — the subject, then the status as
 * an AURA `StatusPill` (portal tones) and the audience and dates — with a
 * chevron. The whole row is the tap target.
 */
import Link from 'next/link';
import { ChevronRightIcon } from 'lucide-react';
import { StatusPill } from '@jirawatpyk/aura-react/server';
import type { BroadcastStatusTone } from '@/components/broadcast/status-badge-mapping';
import { cn } from '@/lib/utils';

/** One history row, formatted once by the panel for table AND cards. */
export interface BroadcastHistoryRowView {
  readonly broadcastId: string;
  readonly subject: string;
  readonly statusLabel: string;
  /** The portal tone for the status (`getPortalBroadcastStatusTone`). */
  readonly statusTone: BroadcastStatusTone;
  readonly estimatedRecipientCount: number;
  /** The audience and its size, formatted: "All members · 130". */
  readonly audience: string;
  /** Formatted in the tenant timezone, or `'—'` when not yet submitted. */
  readonly submitted: string;
  /** Formatted in the tenant timezone, or `'—'` when not yet sent. */
  readonly sent: string;
}

export interface BroadcastHistoryCardListProps {
  readonly rows: ReadonlyArray<BroadcastHistoryRowView>;
  /** The table's column labels, reused as the row's field labels. */
  readonly labels: {
    readonly submittedAt: string;
    readonly sentAt: string;
  };
  /** Forwarded to the root `<ul>` — the panel passes `md:hidden`. */
  readonly className?: string;
}

export function BroadcastHistoryCardList({
  rows,
  labels,
  className,
}: BroadcastHistoryCardListProps): React.ReactElement {
  return (
    <ul
      role="list"
      data-testid="broadcast-history-card-list"
      className={cn(
        'flex flex-col overflow-hidden rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)]',
        className,
      )}
    >
      {rows.map((row) => (
        // No `aria-label` on the item: its one link, named by the row (subject
        // and status first), already gives the summary; a label read it twice.
        <li
          key={row.broadcastId}
          className="border-t border-[var(--aura-border-default)] first:border-t-0"
        >
          <Link
            href={`/portal/broadcasts/${row.broadcastId}`}
            className="flex min-h-11 items-center gap-3 px-4 py-3.5 text-[var(--aura-fg-primary)] no-underline hover:bg-[var(--aura-bg-surface-hover)]"
          >
            <span className="flex min-w-0 grow flex-col gap-1.5">
              <span className="break-words font-semibold">{row.subject}</span>
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <StatusPill tone={row.statusTone} wrap className="max-w-full">
                  {row.statusLabel}
                </StatusPill>
                <span className="aura-text-caption text-[var(--aura-fg-secondary)]">
                  {/* Task #6 (board `Portal-broadcasts-mobile`): "All members · 130". */}
                  <span className="tabular-nums">{row.audience}</span>
                  {/* Dates never break mid-value ("15 ต.ค. 2569", "15 okt. 2026"). */}
                  {row.submitted !== '—' ? (
                    <>
                      {'\u00a0· '}
                      <span className="whitespace-nowrap">
                        {labels.submittedAt} {row.submitted}
                      </span>
                    </>
                  ) : null}
                  {row.sent !== '—' ? (
                    <>
                      {'\u00a0· '}
                      <span className="whitespace-nowrap">
                        {labels.sentAt} {row.sent}
                      </span>
                    </>
                  ) : null}
                </span>
              </span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-[var(--aura-fg-secondary)]" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
