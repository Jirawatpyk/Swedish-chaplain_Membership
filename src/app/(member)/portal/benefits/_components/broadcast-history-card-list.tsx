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
 * `list-style: none`) of `<li>`, each named "{subject}, {status}" for an
 * at-a-glance summary; the status is badge TEXT (WCAG 1.4.1); the table's
 * column headers become visible `<dt>` labels, since a card has no `<th>`.
 */
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** One history row, formatted once by the panel for table AND cards. */
export interface BroadcastHistoryRowView {
  readonly broadcastId: string;
  readonly subject: string;
  readonly statusLabel: string;
  readonly estimatedRecipientCount: number;
  /** Formatted in the tenant timezone, or `'—'` when not yet submitted. */
  readonly submitted: string;
  /** Formatted in the tenant timezone, or `'—'` when not yet sent. */
  readonly sent: string;
}

export interface BroadcastHistoryCardListProps {
  readonly rows: ReadonlyArray<BroadcastHistoryRowView>;
  /** The table's column labels, reused as the card's field labels. */
  readonly labels: {
    readonly audience: string;
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
      className={cn('flex flex-col gap-3', className)}
    >
      {rows.map((row) => (
        <li key={row.broadcastId} aria-label={`${row.subject}, ${row.statusLabel}`}>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/portal/broadcasts/${row.broadcastId}`}
                  className="min-w-0 break-words font-medium text-primary hover:underline"
                >
                  {row.subject}
                </Link>
                <Badge variant="outline" className="shrink-0">
                  {row.statusLabel}
                </Badge>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{labels.audience}</dt>
                <dd className="tabular-nums">{row.estimatedRecipientCount}</dd>
                <dt className="text-muted-foreground">{labels.submittedAt}</dt>
                <dd>{row.submitted}</dd>
                <dt className="text-muted-foreground">{labels.sentAt}</dt>
                <dd>{row.sent}</dd>
              </dl>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
