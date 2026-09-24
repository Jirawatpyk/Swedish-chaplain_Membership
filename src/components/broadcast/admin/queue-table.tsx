/**
 * T117 — Admin review queue table (server async wrapper).
 *
 * Pre-formats every i18n string + locale-aware date so the client-side
 * `QueueTableClient` (TanStack Table v8, rendered via `QueueWithBulk` — see
 * below) renders without needing locale or i18n at runtime. Task 2
 * (2026-08-01-broadcast-review-queue-pr2) removed
 * row virtualization (`@tanstack/react-virtual`, threshold 100 rows,
 * perf.md CHK039) — the queue query pages at 50 rows, so the threshold
 * never fired in production. Task 3 switched the desktop table to the
 * shared `@/components/ui/table.tsx` primitive, matching the
 * members/renewals lists. Task 6 swapped the rendered client component
 * from `QueueTableClient` to `QueueWithBulk` (same props — that wrapper
 * now owns the lifted selection state + the fixed-bottom bulk-action bar).
 */
import { Inbox } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/shell/empty-state';
import type { EnrichedQueueRow, QueueOrder } from './queue-table-client';
import { QueueWithBulk } from './queue-with-bulk';
import { SLA_RED_HOURS, stageAgeOf } from '@/modules/broadcasts';
import type { AdminQueueItem } from '@/lib/admin-broadcast-queue';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';

// Status → badge variant mapping moved to
// `src/components/broadcast/status-badge-mapping.ts` (H4 UX hardening)
// so admin queue, admin detail, and member portal surfaces share one
// source of truth.

/**
 * F119 T117 — one dashboard row, exactly as `loadAdminBroadcastQueue` builds
 * it for the page AND the list API (one projection, FR-030).
 */
export type QueueRow = AdminQueueItem;

export interface QueueTableProps {
  readonly rows: ReadonlyArray<QueueRow>;
  readonly readOnly?: boolean;
  /**
   * Review 2026-09-07 round 2 (UX M-1) — the F3 halt read failed, so this
   * queue may be hiding halted members. Threaded to the bulk-approve confirm
   * dialog, which repeats the warning at the decision point.
   */
  readonly haltUnknown?: boolean;
  /** UX review H1 / M1 — the order the list was read in (`aria-sort` + the visible hint). */
  readonly order?: QueueOrder;
  /** UX review H3 — the whole view's count when known; see `QueueTableClientProps.viewTotal`. */
  readonly viewTotal?: number | null;
  /** UX review H4 — the view's identity (its URL query). */
  readonly viewKey?: string;
}

export async function QueueTable({
  rows,
  readOnly = false,
  haltUnknown = false,
  order = 'longest_in_stage',
  viewTotal = null,
  viewKey = '',
}: QueueTableProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue');
  const tActor = await getTranslations('admin.broadcasts.queue.actorRole');
  const tStatus = await getTranslations('admin.broadcasts.queue.status');
  const tSegment = await getTranslations('admin.broadcasts.review.segmentType');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(
    getDateFormatLocale(locale),
    // Tenant-TZ pin (#315 follow-up, server-UTC display class): without it
    // the Vercel runtime formats submitted/created instants as UTC — 7h off
    // for the Bangkok admin. Canonical tenant TZ (erasure-log precedent).
    { dateStyle: 'medium', timeStyle: 'short', timeZone: env.tenant.timezone },
  );

  // Smart-3 → F119 T117 / T118 — time in stage, re-based on
  // `stage_entered_at` and measured on EVERY waiting stage by the Domain's one
  // comparison (`stageAgeOf`): stalled at 48 h marketing-held / 3 days
  // member-held (red, "Stalled — N days"), the 24 h amber pre-warning on
  // marketing-held stages only. Server component runs once per request —
  // `Date.now()` is the intended request-boundary value. ESLint
  // react-hooks/purity is designed for client render purity; safe here.
  // eslint-disable-next-line react-hooks/purity
  const now = new Date(Date.now());
  const HOURS_PER_DAY = 24;
  const formatInstant = (iso: string | null): string | null =>
    iso === null ? null : dateFormatter.format(new Date(iso));

  const enrichedRows: ReadonlyArray<EnrichedQueueRow> = rows.map((row) => {
    const age = stageAgeOf(row.status, new Date(row.stageEnteredAt), now);
    const days = age === null ? 0 : Math.floor(age.hours / HOURS_PER_DAY);

    // Type-3 (round-3) — single nullable struct so label+variant cannot drift.
    // `red` is the stalled flag, and ONLY `stalled` produces it.
    let ageBadge: { label: string; variant: 'amber' | 'red' } | null = null;
    if (age?.level === 'stalled') {
      ageBadge = { label: t('ageBadge.stalled', { days }), variant: 'red' };
    } else if (age?.level === 'aging') {
      ageBadge = { label: t('ageBadge.aging', { hours: age.hours }), variant: 'amber' };
    }
    // A fresh wait reads in hours up to the review target, then in days.
    const timeInStageLabel =
      age === null
        ? null
        : age.hours < SLA_RED_HOURS
          ? t('timeInStage.hours', { hours: age.hours })
          : t('timeInStage.days', { days });

    const style = getBroadcastStatusBadgeProps(row.status);
    const enriched: EnrichedQueueRow = {
      broadcastId: row.broadcastId,
      subject: row.subject,
      memberDisplayName: row.requestedByMemberDisplayName,
      actorRoleLabel:
        row.actorRole !== 'member_self_service'
          ? tActor(row.actorRole as Parameters<typeof tActor>[0])
          : null,
      segmentLabel: tSegment(row.segmentType as Parameters<typeof tSegment>[0]),
      recipientCount: row.estimatedRecipientCount,
      ageBadge,
      statusBadgeVariant: style.variant,
      statusBadgeLabel: tStatus(row.status),
      actionable: row.status === 'submitted',
      whoseTurnLabel:
        row.whoseTurn === null
          ? null
          : row.whoseTurn === 'member'
            ? t('whoseTurn.member')
            : t('whoseTurn.marketing'),
      timeInStageLabel,
      round: row.currentRound,
      proposedSendAtFormatted: formatInstant(row.proposedSendAt),
      confirmedSendAtFormatted: formatInstant(row.confirmedSendAt),
      lastActivityFormatted: dateFormatter.format(new Date(row.stageEnteredAt)),
      deliverySummary:
        row.delivery === null
          ? null
          : t('delivery.summary', {
              recipients: row.delivery.recipients,
              delivered: row.delivery.delivered,
              bounced: row.delivery.bounced,
              complained: row.delivery.complained,
            }),
    };
    if (style.className !== undefined) {
      return { ...enriched, statusBadgeClassName: style.className };
    }
    return enriched;
  });

  return (
    <QueueWithBulk
      rows={enrichedRows}
      readOnly={readOnly}
      haltUnknown={haltUnknown}
      order={order}
      viewTotal={viewTotal}
      viewKey={viewKey}
      emptyState={
        // UX-C5: empty state with title + body + visual anchor (no CTA —
        // admin can't manufacture submissions; queue empties when members
        // submit). F119 T109 — rendered INSIDE the client component, so the
        // list's one live region survives a stage change to an empty view.
        // UX review LOW — the shared `EmptyState`, with its own `role="status"`
        // switched off: the queue's announcer already says "No E-Blasts in
        // this view", and FR-025 allows the list ONE live region.
        <EmptyState
          icon={Inbox}
          title={t('emptyTitle')}
          description={t('empty')}
          announce={false}
        />
      }
      columnLabels={{
        member: t('columns.member'),
        subject: t('columns.subject'),
        status: t('columns.status'),
        whoseTurn: t('columns.whoseTurn'),
        timeInStage: t('columns.timeInStage'),
        sendTime: t('columns.sendTime'),
        audience: t('columns.segment'),
        actions: t('columns.actions'),
        select: t('bulk.selectAria'),
        tableAria: t('tableAria'),
      }}
    />
  );
}
