/**
 * T117 — Admin review queue table (server async wrapper).
 *
 * Pre-formats every i18n string + locale-aware date so the client-side
 * `QueueTableClient` (TanStack Table v8 + react-virtual) renders without
 * needing locale or i18n at runtime. Activates virtualization above 100
 * rows (perf.md CHK039).
 */
import { Inbox } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  QueueTableClient,
  type EnrichedQueueRow,
} from './queue-table-client';
import type { BroadcastStatus } from '@/modules/broadcasts';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import { getDateFormatLocale } from '@/lib/format-date-localised';

// Status → badge variant mapping moved to
// `src/components/broadcast/status-badge-mapping.ts` (H4 UX hardening)
// so admin queue, admin detail, and member portal surfaces share one
// source of truth.

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
    getDateFormatLocale(locale),
    { dateStyle: 'medium', timeStyle: 'short' },
  );

  if (rows.length === 0) {
    // UX-C5: empty state with title + body + visual anchor (no CTA —
    // admin can't manufacture submissions; queue empties when members
    // submit).
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/20 px-4 py-12 text-center">
        <div className="rounded-full bg-background p-3">
          <Inbox
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <p className="text-sm font-medium">{t('emptyTitle')}</p>
        <p className="max-w-md text-xs text-muted-foreground">{t('empty')}</p>
      </div>
    );
  }

  // Smart-3 — SLA age badge thresholds. 48h review SLA target per spec
  // FR-013 (Clarifications session Q2).
  // Server component runs once per request — `Date.now()` is the
  // intended request-boundary value. ESLint react-hooks/purity is
  // designed for client render purity; safe here.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const SLA_AMBER_HOURS = 24;
  const SLA_RED_HOURS = 48;

  const enrichedRows: ReadonlyArray<EnrichedQueueRow> = rows.map((row) => {
    const submittedAtIso = row.submittedAt ?? row.createdAt;
    const submittedDate = new Date(submittedAtIso);
    const submittedAt = dateFormatter.format(submittedDate);
    const hoursWaiting =
      row.status === 'submitted'
        ? Math.floor((nowMs - submittedDate.getTime()) / (60 * 60 * 1000))
        : null;

    // Type-3 (round-3) — single nullable struct so label+variant cannot drift.
    let ageBadge: { label: string; variant: 'amber' | 'red' } | null = null;
    if (hoursWaiting !== null && hoursWaiting >= SLA_RED_HOURS) {
      ageBadge = {
        label: t('ageBadge.overdue', { hours: hoursWaiting }),
        variant: 'red',
      };
    } else if (hoursWaiting !== null && hoursWaiting >= SLA_AMBER_HOURS) {
      ageBadge = {
        label: t('ageBadge.aging', { hours: hoursWaiting }),
        variant: 'amber',
      };
    }

    const style = getBroadcastStatusBadgeProps(row.status);
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
      ageBadge,
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
        select: t('bulk.selectAria'),
        bulkApprove: t('bulk.approveSelected'),
        bulkClear: t('bulk.clear'),
        // Raw templates — client substitutes {count}/{ok}/{fail} via .replace()
        bulkSelected: t.raw('bulk.selected') as string,
        bulkSuccess: t('bulk.successAll'),
        bulkFailure: t('bulk.failureAll'),
        bulkPartial: t.raw('bulk.partial') as string,
        tableAria: t('tableAria'),
      }}
    />
  );
}
