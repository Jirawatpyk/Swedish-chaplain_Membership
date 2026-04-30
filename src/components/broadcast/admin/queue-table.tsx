/**
 * T117 — Admin review queue table (server component).
 *
 * Plain shadcn `<Table>` — mirrors F4 invoice-list pattern (per
 * Ultraplan AD9, no TanStack Table v8 in MVP). Server-rendered with
 * server-side filter+sort+cursor pagination.
 *
 * Columns: submittedAt (relative), member display, subject, segment,
 * recipientCount, status badge, actions. Manager role: actions cell
 * hidden via `readOnly` prop.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { StatusBadge } from './status-badge';
import { ReviewActions } from './review-actions';
import type { BroadcastStatus } from '@/modules/broadcasts';

export interface QueueRow {
  readonly broadcastId: string;
  readonly status: BroadcastStatus;
  readonly subject: string;
  readonly requestedByMemberId: string;
  readonly requestedByMemberDisplayName: string;
  readonly actorRole: string;
  readonly segmentType: string;
  readonly estimatedRecipientCount: number;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

export interface QueueTableProps {
  readonly rows: ReadonlyArray<QueueRow>;
  readonly readOnly?: boolean;
}

export async function QueueTable({
  rows,
  readOnly = false,
}: QueueTableProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue');
  const tActor = await getTranslations('admin.broadcasts.queue.actorRole');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium', timeStyle: 'short' },
  );

  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[920px] text-sm">
        <thead className="bg-muted/50 text-xs uppercase tracking-wide">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              {t('columns.submittedAt')}
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              {t('columns.member')}
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              {t('columns.subject')}
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              {t('columns.segment')}
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              {t('columns.recipientCount')}
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              {t('columns.status')}
            </th>
            {!readOnly ? (
              <th scope="col" className="px-3 py-2 text-left">
                {t('columns.actions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.broadcastId} className="border-t">
              <td className="px-3 py-2 text-muted-foreground tabular-nums">
                {row.submittedAt !== null
                  ? dateFormatter.format(new Date(row.submittedAt))
                  : dateFormatter.format(new Date(row.createdAt))}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col">
                  <span className="font-medium">{row.requestedByMemberDisplayName}</span>
                  {row.actorRole !== 'member_self_service' ? (
                    <span className="text-xs text-muted-foreground">
                      {tActor(row.actorRole as Parameters<typeof tActor>[0])}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2">
                <Link
                  href={`/admin/broadcasts/${row.broadcastId}`}
                  className="font-medium text-primary hover:underline"
                >
                  {row.subject}
                </Link>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {row.segmentType}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {row.estimatedRecipientCount}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={row.status} />
              </td>
              {!readOnly ? (
                <td className="px-3 py-2">
                  {row.status === 'submitted' ? (
                    <ReviewActions broadcastId={row.broadcastId} />
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
