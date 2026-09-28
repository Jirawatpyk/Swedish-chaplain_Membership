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
import { AlertTriangleIcon, ReceiptTextIcon } from 'lucide-react';
import { Badge, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ChangeRequestQueueItem } from '@/modules/members';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import {
  ChangeRequestStatusBadge,
  changeRequestStatusOf,
} from '@/components/members/change-requests/change-request-status-badge';

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
    <Table data-testid="queue-table" caption={t('tableCaption')} captionHidden stackBelow="sm">
      <THead>
        <Tr>
          <Th>{t('columns.member')}</Th>
          <Th>{t('columns.submitter')}</Th>
          <Th>{t('columns.fields')}</Th>
          <Th>{t('columns.submitted')}</Th>
          <Th>{t('columns.waiting')}</Th>
          <Th>{t('columns.status')}</Th>
          <Th align="end">
            <span className="sr-only">{t('columns.actions')}</span>
          </Th>
        </Tr>
      </THead>
      <TBody>
        {items.map((item) => {
          const r = item.row.request;
          const wait = waitingParts(item.waitingSeconds);
          const rowId = `cr-row-${r.id}`;
          return (
            <Tr key={r.id} data-testid="queue-row" data-request-id={r.id} data-overdue={item.overdue ? 'true' : undefined}>
              <Td label={t('columns.member')}>
                <div className="font-medium">{item.row.member.companyName}</div>
                <div className="font-mono text-xs text-[var(--aura-fg-secondary)]">
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
                  <div className="flex items-center gap-1 text-xs text-[var(--aura-fg-secondary)]">
                    <ReceiptTextIcon className="size-3" aria-hidden="true" />
                    {tReview('markers.taxAffecting')}
                  </div>
                ) : null}
              </Td>
              <Td label={t('columns.submitted')}>{fmt(r.submittedAt)}</Td>
              <Td label={t('columns.waiting')}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span id={`${rowId}-waiting`}>{wait.days > 0 ? t('waitingDays', { count: wait.days }) : t('waitingHours', { count: wait.hours })}</span>
                  {item.overdue ? (
                    <Badge tone="danger" icon={<AlertTriangleIcon aria-hidden="true" />} data-testid="overdue-badge">
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
              <Td align="end">
                <Link
                  href={`/admin/change-requests/${r.id}`}
                  className={buttonClass({ variant: 'secondary', size: 'sm' })}
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
  );
}
