/**
 * F9 US3 — unified multi-source timeline event item.
 *
 * Renders a single `member_timeline_v` row. The label is resolved from
 * `(source, eventType)` (FR-014):
 *   - `audit` rows reuse the existing `audit.eventType.*` catalogue, falling
 *     back to the legacy `payload.summary` string, then the source label. On
 *     the portal (`audience="member"`) `timeline.memberAudit.*` comes first.
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
  BellIcon,
  CalendarCheckIcon,
  CircleCheckIcon,
  FileTextIcon,
  MailIcon,
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
  /**
   * Spec 122 US3 — `compact` is the dashboard's "Recent activity" row (the
   * `Main` board): the event at regular weight, a soft source badge and the
   * date in its own column, no actor; on phones the date sits under the event
   * and the badge leaves. The default is the timeline page's row.
   */
  readonly variant?: 'default' | 'compact';
  /**
   * Who reads the row. `member` (the portal) names an audit row from
   * `timeline.memberAudit.*` — the member's own words ("Invoice cancelled",
   * not "Invoice voided") — and falls back to the staff `audit.eventType.*`
   * catalogue for a type with no member wording. The default is staff.
   */
  readonly audience?: 'staff' | 'member';
};

const SYSTEM_ACTORS = new Set(['system', 'system:bootstrap', 'anonymous']);

// The icon set of the `Main` and `Portal-timeline` boards.
const SOURCE_ICON: Record<TimelineSource, LucideIcon> = {
  audit: UserCogIcon,
  invoice: FileTextIcon,
  payment: CircleCheckIcon,
  event: CalendarCheckIcon,
  broadcast: MailIcon,
  renewal: BellIcon,
};

/** "15 Sep 2026" / "15 ก.ย. 2569" — the date column of the compact row. */
function formatTimelineDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }).format(d);
}

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

type RowDetail = { readonly text: string; readonly mono: boolean };

const payloadString = (payload: Record<string, unknown> | null, key: string): string | null => {
  const v = payload?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/**
 * Spec 122 US3 (`Portal-timeline` / `Main` boards) — what a non-audit row is
 * about, as the repo resolved it: the document number (a stable identifier,
 * mono), the event's name or the E-Blast's subject (prose).
 */
function sourceDetail(source: TimelineSource, payload: Record<string, unknown> | null): RowDetail | null {
  switch (source) {
    case 'invoice':
    case 'payment': {
      const number = payloadString(payload, 'document_number');
      return number ? { text: number, mono: true } : null;
    }
    case 'event': {
      const name = payloadString(payload, 'event_name');
      return name ? { text: name, mono: false } : null;
    }
    case 'broadcast': {
      const subject = payloadString(payload, 'broadcast_subject');
      return subject ? { text: subject, mono: false } : null;
    }
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
  variant = 'default',
  audience = 'staff',
}: TimelineItemProps) {
  const t = useTranslations('admin.members.timeline');
  const tPayload = useTranslations('admin.members.timeline.payload');
  const tAuditEvent = useTranslations('audit.eventType');
  const tTimeline = useTranslations('timeline');
  const tFieldLabel = useTranslations('portal.changeRequests.diff.labels');
  const tMethod = useTranslations('portal.payment.methods');
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
    const memberKey = `memberAudit.${eventType}`;
    if (audience === 'member' && tTimeline.has(memberKey as 'unknownEvent')) {
      eventLabel = tTimeline(memberKey as 'unknownEvent');
    } else if (tAuditEvent.has(eventType)) {
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

  // The row badge names a profile change "Profile" (the boards); the filter keeps "Profile / Audit".
  const sourceLabel = source === 'audit' ? tTimeline('sourceBadgeAudit') : tTimeline(`source.${source}` as 'source.audit');
  const SourceIcon = SOURCE_ICON[source];
  let payloadDetail: RowDetail | null;
  if (source !== 'audit') {
    payloadDetail = sourceDetail(source, payload);
  } else if (eventType.startsWith('member_change_request_') && Array.isArray(payload?.field_keys)) {
    // The fields a change request touched, by their form labels ("Registered address, Website").
    const labels = payload.field_keys
      .filter((k): k is string => typeof k === 'string')
      .map((k) => (tFieldLabel.has(k as 'website') ? tFieldLabel(k as 'website') : k));
    payloadDetail = labels.length > 0 ? { text: labels.join(', '), mono: false } : null;
  } else {
    const text = formatAuditPayload(eventType, payload, tPayload);
    payloadDetail = text ? { text, mono: true } : null;
  }
  // A payment row names how it was paid on the actor line (the board's "Anna Lindqvist · PromptPay · 10:03").
  const method = source === 'payment' ? payloadString(payload, 'payment_method') : null;
  const methodLabel = method && tMethod.has(method as 'card') ? tMethod(method as 'card') : null;

  const chip = (
    // Source marker — reduced-motion friendly (static icon, no pulse). 36px on
    // the hover surface, as both boards draw it.
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--aura-bg-surface-hover)] text-[var(--aura-fg-secondary)]"
    >
      <SourceIcon className="size-4" />
    </span>
  );
  const label = (
    <>
      <span>{eventLabel}</span>
      {payloadDetail ? (
        <>
          {' · '}
          <span className={payloadDetail.mono ? 'font-mono text-xs' : undefined}>{payloadDetail.text}</span>
        </>
      ) : null}
    </>
  );

  if (variant === 'compact') {
    const date = formatTimelineDate(timestamp, locale);
    const time = (className: string) => (
      <time
        dateTime={timestamp}
        title={formatLocalisedTimestamp(timestamp, locale)}
        suppressHydrationWarning
        className={className}
      >
        {date}
      </time>
    );
    return (
      <div className="flex items-center gap-4 py-3" data-event-type={eventType} data-source={source}>
        {chip}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm">{label}</p>
          {time('text-xs text-[var(--aura-fg-secondary)] sm:hidden')}
        </div>
        <Badge className="shrink-0 max-sm:hidden">{sourceLabel}</Badge>
        {time('w-28 shrink-0 text-right text-xs text-[var(--aura-fg-secondary)] max-sm:hidden')}
      </div>
    );
  }

  // Spec 122 US3 (`Portal-timeline` boards): an icon chip, the event (and
  // its detail) over "actor · time", an outline source badge beside it —
  // under it on phones. Under Today the time alone; elsewhere date and time.
  const timeOnly = timelineGroup(timestamp)?.kind === 'today';

  return (
    <div className="flex items-start gap-3 py-3 sm:items-center" data-event-type={eventType} data-source={source}>
      {chip}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-[var(--aura-fg-secondary)]">
            {actorDisplay}
            {methodLabel ? ` · ${methodLabel}` : null}
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
