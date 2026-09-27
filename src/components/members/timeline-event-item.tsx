/**
 * F9 US3 — unified multi-source timeline event item.
 *
 * Renders a single `member_timeline_v` row. The label is resolved from
 * `(source, eventType)` (FR-014):
 *   - `audit` rows reuse the existing `audit.eventType.*` catalogue, falling
 *     back to the legacy `payload.summary` string, then the source label.
 *   - the other five sources resolve `timeline.<source>.<eventKind>`,
 *     falling back to the localized source label.
 *
 * Actor attribution: audit rows show the resolved staff display name; the
 * other sources have no single acting user, so a localized actor-kind label
 * (Staff / Member / System) is shown instead.
 *
 * FR-024: keyboard-accessible, aria-labelled, reduced-motion friendly.
 */

import { useTranslations, useLocale } from 'next-intl';
import {
  CreditCardIcon,
  FileTextIcon,
  CalendarCheckIcon,
  MegaphoneIcon,
  RefreshCwIcon,
  UserCogIcon,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@jirawatpyk/aura-react/server';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { formatTimelineTime, timelineGroup } from '@/lib/timeline-groups';
import type { TimelineSource, TimelineActorKind } from '@/lib/timeline-shared';

export type TimelineItemProps = {
  readonly id: string;
  readonly timestamp: string;
  readonly source: TimelineSource;
  readonly eventType: string;
  readonly actorKind: TimelineActorKind;
  /** Audit-only (the acting user). Absent for non-audit sources. */
  readonly actorUserId?: string;
  readonly actorDisplayName: string | null;
  readonly payload: Record<string, unknown> | null;
};

const SYSTEM_ACTORS = new Set(['system', 'system:bootstrap', 'anonymous']);

const SOURCE_ICON: Record<TimelineSource, LucideIcon> = {
  audit: UserCogIcon,
  invoice: FileTextIcon,
  payment: CreditCardIcon,
  event: CalendarCheckIcon,
  broadcast: MegaphoneIcon,
  renewal: RefreshCwIcon,
};

/**
 * Locale-aware timestamp formatter. Thai uses Buddhist Era (BE = CE + 543)
 * natively via the `-u-ca-buddhist` extension (Constitution § Conventions);
 * en/sv use Gregorian. The machine-readable ISO stays in `<time dateTime>`.
 */
export function formatLocalisedTimestamp(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      // Hydration safety (2026-07-31 #418 incident class): this module is
      // imported by 'use client' surfaces (timeline-stream, at-risk-widget,
      // portal recent-activity), so it formats on BOTH the UTC server and
      // the Bangkok browser — without a pinned zone the hour always
      // differed at hydration. See format-date-localised.ts's
      // timezone-default doc.
      timeZone: 'Asia/Bangkok',
    }).format(d);
  } catch {
    return iso.replace('T', ' ').slice(0, 16);
  }
}

/**
 * Compact, human-readable payload one-liner for AUDIT rows (avoids raw
 * UUIDs). Returns null when nothing useful to show. The non-audit sources
 * carry their state in the localised label, so they pass through here only
 * for the audit catalogue.
 */
function formatAuditPayload(
  eventType: string,
  payload: Record<string, unknown> | null,
  tPayload: (
    key: 'primary' | 'primaryContactPromoted' | 'archiveReason',
    values?: Record<string, string | number>,
  ) => string,
): string | null {
  if (!payload) return null;
  const get = (k: string): string | null => {
    const v = payload[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  switch (eventType) {
    case 'member_created': {
      const company = get('company_name');
      return company ? `“${company}”` : null;
    }
    case 'member_updated':
    case 'member_self_updated':
    case 'contact_created':
    case 'contact_updated':
    case 'contact_removed': {
      const fields = payload.fields_changed;
      if (Array.isArray(fields) && fields.length > 0) return `${fields.join(', ')}`;
      if (payload.is_primary === true) return tPayload('primary');
      return null;
    }
    case 'member_plan_changed': {
      const oldName = get('old_plan_name');
      const newName = get('new_plan_name');
      if (oldName && newName) return `${oldName} → ${newName}`;
      const oldId = get('old_plan_id');
      const newId = get('new_plan_id');
      if (oldId && newId) {
        const fmt = (s: string) => (s.length > 10 ? `…${s.slice(-6)}` : s);
        return `${fmt(oldId)} → ${fmt(newId)}`;
      }
      return null;
    }
    case 'plan_bundle_changed': {
      const oldName = get('old_includes_corporate_plan_name');
      const newName = get('new_includes_corporate_plan_name');
      if (oldName && newName) return `${oldName} → ${newName}`;
      return null;
    }
    case 'member_status_changed': {
      const oldS = get('old_status');
      const newS = get('new_status');
      return oldS && newS ? `${oldS} → ${newS}` : null;
    }
    case 'member_primary_contact_changed':
      return tPayload('primaryContactPromoted');
    case 'member_archived': {
      const reason = get('reason');
      return reason ? tPayload('archiveReason', { reason }) : null;
    }
    // 088 (T019a / FR-029) — surface the §87 `RC` tax-receipt number minted at
    // payment so the "Tax receipt issued" row names WHICH receipt. The RC lives
    // in `receipt_document_number_raw` (record-payment / issue-event-invoice-as-
    // paid emit). No i18n key: the number is a stable identifier, shown verbatim
    // like the `member_created` company one-liner.
    case 'tax_receipt_issued':
      return get('receipt_document_number_raw');
    default:
      return null;
  }
}

export function TimelineEventItem({
  source,
  timestamp,
  eventType,
  actorUserId,
  actorKind,
  actorDisplayName,
  payload,
}: TimelineItemProps) {
  const t = useTranslations('admin.members.timeline');
  const tPayload = useTranslations('admin.members.timeline.payload');
  const tAuditEvent = useTranslations('audit.eventType');
  const tTimeline = useTranslations('timeline');
  const locale = useLocale();

  // --- localised label resolution (FR-014) --------------------------------
  let eventLabel: string;
  if (source === 'audit') {
    // `.has` guard (NOT a try/catch): the `audit.eventType` catalogue now covers
    // every `audit_event_type` enum value (pinned by
    // tests/unit/insights/audit-event-label-coverage.test.ts), but keep the
    // guard as defence for rows written by a migration that lands ahead of its
    // label. Calling `tAuditEvent(eventType)` on a missing key makes next-intl's
    // onError reporter log `MISSING_MESSAGE` to the console BEFORE a try/catch
    // can swallow the throw — so guard with `.has` first (silent), falling back
    // to the row summary then the source label. Mirrors the shared
    // `resolveEventLabel` helper (src/lib/audit-event-label.ts).
    if (tAuditEvent.has(eventType)) {
      eventLabel = tAuditEvent(eventType);
    } else {
      const summary = typeof payload?.summary === 'string' ? payload.summary : '';
      eventLabel = summary.length > 0 ? summary : tTimeline('source.audit');
    }
  } else {
    // `.has` guard (NOT try/catch), same reason as the audit branch above:
    // next-intl's onError reporter logs `MISSING_MESSAGE` to console.error
    // BEFORE a catch can run (t() returns the key path, it does not throw), so
    // try/catch is dead code AND noisy. An uncatalogued non-audit event-kind
    // (e.g. a payment `partially_refunded` that has no `timeline.payment.*`
    // key) must fall back silently to the source label.
    // (code-review max F9 — finding #6)
    const tlKey = `${source}.${eventType}`;
    eventLabel = tTimeline.has(tlKey as 'unknownEvent')
      ? tTimeline(tlKey as 'unknownEvent')
      : tTimeline(`source.${source}` as 'unknownEvent');
  }

  // --- actor attribution --------------------------------------------------
  let actorDisplay: string;
  if (source === 'audit') {
    actorDisplay = SYSTEM_ACTORS.has(actorUserId ?? '')
      ? t('actorSystem')
      : (actorDisplayName ?? tTimeline(`actorKind.${actorKind}` as 'actorKind.staff'));
  } else {
    actorDisplay = tTimeline(`actorKind.${actorKind}` as 'actorKind.staff');
  }

  const sourceLabel = tTimeline(`source.${source}` as 'source.audit');
  const SourceIcon = SOURCE_ICON[source];
  const payloadDetail =
    source === 'audit' ? formatAuditPayload(eventType, payload, tPayload) : null;

  // Spec 122 US3 (`Portal-timeline` boards): an icon chip, the event (and
  // its detail) over "actor · time", an outline source badge beside it —
  // under it on phones. Under Today the time alone; elsewhere date and time.
  const timeOnly = timelineGroup(timestamp)?.kind === 'today';

  return (
    <div className="flex items-start gap-3 py-3 sm:items-center" data-event-type={eventType} data-source={source}>
      {/* Source marker — reduced-motion friendly (static icon, no pulse). */}
      <span
        aria-hidden
        className="mt-0.5 flex size-8 shrink-0 sm:mt-0 items-center justify-center rounded-full bg-[var(--aura-bg-canvas)] text-[var(--aura-fg-secondary)]"
      >
        <SourceIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">
            <span>{eventLabel}</span>
            {payloadDetail ? (
              <>
                {' · '}
                <span>{payloadDetail}</span>
              </>
            ) : null}
          </p>
          <p className="text-xs text-[var(--aura-fg-secondary)]">
            {actorDisplay}
            {' · '}
            <time
              dateTime={timestamp}
              title={formatLocalisedTimestamp(timestamp, locale)}
              suppressHydrationWarning
            >
              {formatTimelineTime(timestamp, locale, timeOnly)}
            </time>
          </p>
        </div>
        {/* AURA outline badge — a designed ≥4.5:1 pair (WCAG 1.4.3). */}
        <Badge variant="outline" className="w-fit shrink-0">
          {sourceLabel}
        </Badge>
      </div>
    </div>
  );
}
