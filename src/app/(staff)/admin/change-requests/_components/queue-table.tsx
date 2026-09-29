/**
 * F114 — the change-request queue table. 122 US5a (T507): an AURA table
 * (board `Admin-change-requests`), rows as cards below 640px. A static
 * table, not DataTable: no sort, no selection, and every row keeps its test
 * id / request id / overdue flag. Its own server component so the no-DB
 * preview route renders the same markup (T509).
 *
 * Every cell passes its card `label`: AURA reads the labels from `THead`,
 * which a server component hands over as a client reference it cannot
 * inspect, so without them the phone cards lose their field names.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Badge, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestQueueItem } from '@/modules/members';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import {
  ChangeRequestStatusBadge,
  changeRequestStatusOf,
} from '@/components/members/change-requests/change-request-status-badge';

// On a phone each row is the board's card (`Admin-change-requests-mobile`):
// the company and member number as its title with Review beside it, the other
// cells two to a line below (AURA 5.13 Td card slots, #84). The board draws
// the cards apart, each framed, where AURA stacks them in one divided frame:
// our own frame on each stacked row (CARD), in the container query AURA
// stacks the rows in (`aura-tbl`, below 640px). A stand-in until AURA #85
// (separate cards for a stacked static Table).
const CARD = '@max-[640px]/aura-tbl:mb-3 @max-[640px]/aura-tbl:rounded-[var(--aura-card-radius)] @max-[640px]/aura-tbl:!border @max-[640px]/aura-tbl:!border-[var(--aura-border-default)] @max-[640px]/aura-tbl:bg-[var(--aura-bg-surface)] @max-[640px]/aura-tbl:!p-4';

/** Whole days / hours for the waiting column — the exact seconds are not what a reviewer scans for. */
function waitingParts(seconds: number): { days: number; hours: number } {
  return { days: Math.floor(seconds / 86_400), hours: Math.floor((seconds % 86_400) / 3600) };
}

export async function ChangeRequestQueueTable({
  items,
}: {
  readonly items: readonly ChangeRequestQueueItem[];
}) {
  const t = await getTranslations('admin.changeRequests.queue');
  const tReview = await getTranslations('admin.changeRequests.review');
  const locale = await getLocale();
  const fmt = (d: Date) => formatLocalisedDate(d.toISOString(), locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    // On a phone the cards stand apart, so the list itself loses its frame
    // (the table keeps it from 640px). Part of the stand-in until AURA #85.
    <div data-queue="board" className="max-sm:[&_.aura-tbl-wrap]:rounded-none max-sm:[&_.aura-tbl-wrap]:border-0 max-sm:[&_.aura-tbl-wrap]:bg-transparent">
    <Table data-testid="queue-table" caption={t('tableCaption')} captionHidden stackBelow="sm" align="middle">
      <THead>
        <Tr>
          <Th>{t('columns.member')}</Th>
          <Th>{t('columns.submitter')}</Th>
          <Th>{t('columns.fields')}</Th>
          <Th>{t('columns.submitted')}</Th>
          <Th>{t('columns.waiting')}</Th>
          <Th>{t('columns.status')}</Th>
          <Th>{t('columns.actions')}</Th>
        </Tr>
      </THead>
      <TBody>
        {items.map((item) => {
          const r = item.row.request;
          const wait = waitingParts(item.waitingSeconds);
          const rowId = `cr-row-${r.id}`;
          return (
            <Tr key={r.id} className={CARD} data-testid="queue-row" data-request-id={r.id} data-overdue={item.overdue ? 'true' : undefined}>
              {/* No card label: the company is the card's title. */}
              <Td card="title">
                <div className="font-medium">{item.row.member.companyName}</div>
                {/* Muted in the table, bold in the phone card's title (boards).
                    AURA app content: the number's weight on a stacked card. */}
                <div className="text-xs text-[var(--aura-fg-secondary)] @max-[640px]/aura-tbl:font-semibold @max-[640px]/aura-tbl:text-[var(--aura-fg-primary)]">
                  #{item.row.member.memberNumber}
                  {item.row.member.archived ? ` · ${t('archivedMember')}` : null}
                </div>
              </Td>
              <Td label={t('columns.submitter')}>
                <div>{item.row.submitter.displayName}</div>
                <div className="text-xs text-[var(--aura-fg-secondary)]">{tReview(`roles.${r.submitterRoleAtSubmission}`)}</div>
              </Td>
              <Td label={t('columns.fields')}>
                <div>{t('fieldCount', { count: r.fields.length })}</div>
                {r.fields.some((f) => f.affectsTaxDocuments) ? (
                  <div className="text-xs text-[var(--aura-fg-secondary)]">
                    {tReview('markers.taxAffecting')}
                  </div>
                ) : null}
              </Td>
              <Td className="whitespace-nowrap" label={t('columns.submitted')}>{fmt(r.submittedAt)}</Td>
              <Td label={t('columns.waiting')}>
                <span className="inline-flex flex-nowrap items-center gap-2 whitespace-nowrap">
                  <span id={`${rowId}-waiting`}>{wait.days > 0 ? t('waitingDays', { count: wait.days }) : t('waitingHours', { count: wait.hours })}</span>
                  {item.overdue ? (
                    <Badge tone="danger" data-testid="overdue-badge">
                      {t('overdue')}
                    </Badge>
                  ) : null}
                </span>
              </Td>
              <Td label={t('columns.status')}>
                <ChangeRequestStatusBadge status={changeRequestStatusOf(r)} audience="staff" />
                {r.decidedAt && item.row.decidedBy ? (
                  <div className="mt-1 text-xs text-[var(--aura-fg-secondary)]">
                    {tReview('decidedBy', { name: item.row.decidedBy.displayName || tReview('unknownReviewer'), decidedAt: fmt(r.decidedAt) })}
                    {item.row.decidedBy.deactivated ? ` ${tReview('deactivated')}` : null}
                  </div>
                ) : null}
              </Td>
              <Td card="action">
                <Link
                  href={`/admin/change-requests/${r.id}`}
                  // `sm` in the table (AURA's table rule); a phone card takes
                  // the default button height, as the mobile board draws it.
                  // AURA's own height token, no pixels; it keys on AURA's
                  // stacking container. Part of the stand-in until AURA #85.
                  className={buttonClass({
                    variant: 'secondary',
                    size: 'sm',
                    className: '@max-[640px]/aura-tbl:h-[var(--aura-button-height)]',
                  })}
                  aria-label={r.state === 'pending' ? t('reviewFor', { company: item.row.member.companyName }) : t('viewFor', { company: item.row.member.companyName })}
                  aria-describedby={`${rowId}-waiting`}
                >
                  {r.state === 'pending' ? t('open') : t('view')}
                </Link>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
    </div>
  );
}
