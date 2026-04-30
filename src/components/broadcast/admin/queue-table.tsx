/**
 * T117 — Admin review queue table (server async wrapper).
 *
 * Pre-formats every i18n string + locale-aware date so the client-side
 * `QueueTableClient` (TanStack Table v8 + react-virtual) renders without
 * needing locale or i18n at runtime. Activates virtualization above 100
 * rows (perf.md CHK039).
 */
import { getLocale, getTranslations } from 'next-intl/server';
import {
  QueueTableClient,
  type EnrichedQueueRow,
} from './queue-table-client';
import type { BroadcastStatus } from '@/modules/broadcasts';

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost';

const STATUS_STYLE: Record<
  BroadcastStatus,
  { variant: BadgeVariant; className?: string }
> = {
  draft: { variant: 'outline', className: 'text-muted-foreground' },
  submitted: { variant: 'secondary' },
  approved: { variant: 'default' },
  sending: { variant: 'default', className: 'motion-safe:animate-pulse' },
  sent: { variant: 'default' },
  rejected: { variant: 'destructive' },
  cancelled: { variant: 'outline', className: 'text-muted-foreground' },
  failed_to_dispatch: { variant: 'destructive' },
};

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
  const tStatus = await getTranslations('admin.broadcasts.queue.status');
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

  const enrichedRows: ReadonlyArray<EnrichedQueueRow> = rows.map((row) => {
    const submittedAt =
      row.submittedAt !== null
        ? dateFormatter.format(new Date(row.submittedAt))
        : dateFormatter.format(new Date(row.createdAt));
    const style = STATUS_STYLE[row.status];
    const enriched: EnrichedQueueRow = {
      broadcastId: row.broadcastId,
      subject: row.subject,
      memberDisplayName: row.requestedByMemberDisplayName,
      actorRoleLabel:
        row.actorRole !== 'member_self_service'
          ? tActor(row.actorRole as Parameters<typeof tActor>[0])
          : null,
      segmentLabel: row.segmentType,
      recipientCount: row.estimatedRecipientCount,
      submittedAtFormatted: submittedAt,
      statusBadgeVariant: style.variant,
      statusBadgeLabel: tStatus(row.status),
      actionable: row.status === 'submitted',
    };
    if (style.className !== undefined) {
      return { ...enriched, statusBadgeClassName: style.className };
    }
    return enriched;
  });

  return (
    <QueueTableClient
      rows={enrichedRows}
      readOnly={readOnly}
      columnLabels={{
        submittedAt: t('columns.submittedAt'),
        member: t('columns.member'),
        subject: t('columns.subject'),
        segment: t('columns.segment'),
        recipientCount: t('columns.recipientCount'),
        status: t('columns.status'),
        actions: t('columns.actions'),
      }}
    />
  );
}
