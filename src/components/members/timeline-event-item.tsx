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
import { RelativeTime } from '@/components/ui/relative-time';
import type { TimelineSource, TimelineActorKind } from '@/lib/timeline-shared';

export type TimelineItemProps = {
  readonly id: string;
  readonly timestamp: string;
  readonly source: TimelineSource;
  readonly eventType: string;
  readonly actorKind: TimelineActorKind;
  readonly actorUserId: string;
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
  const bcp47 = locale === 'th' ? 'th-TH-u-ca-buddhist' : locale;
  try {
    return new Intl.DateTimeFormat(bcp47, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
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
    try {
      eventLabel = tAuditEvent(eventType);
    } catch {
      // Legacy summary fallback, then the source label.
      const summary = typeof payload?.summary === 'string' ? payload.summary : '';
      eventLabel = summary.length > 0 ? summary : tTimeline('source.audit');
    }
  } else {
    try {
      eventLabel = tTimeline(`${source}.${eventType}` as 'unknownEvent');
    } catch {
      eventLabel = tTimeline(`source.${source}` as 'unknownEvent');
    }
  }

  // --- actor attribution --------------------------------------------------
  let actorDisplay: string;
  if (source === 'audit') {
    actorDisplay = SYSTEM_ACTORS.has(actorUserId)
      ? t('actorSystem')
      : (actorDisplayName ?? tTimeline(`actorKind.${actorKind}` as 'actorKind.staff'));
  } else {
    actorDisplay = tTimeline(`actorKind.${actorKind}` as 'actorKind.staff');
  }

  const sourceLabel = tTimeline(`source.${source}` as 'source.audit');
  const SourceIcon = SOURCE_ICON[source];
  const payloadDetail =
    source === 'audit' ? formatAuditPayload(eventType, payload, tPayload) : null;

  return (
    <div
      className="relative border-l-2 border-muted pl-6 py-3"
      data-event-type={eventType}
      data-source={source}
    >
      {/* Source marker — reduced-motion friendly (static icon, no pulse). */}
      <span
        aria-hidden
        className="absolute -left-[13px] top-4 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground"
      >
        <SourceIcon className="size-3.5" />
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-sm">{eventLabel}</span>
          {/* bg-secondary/text-secondary-foreground is a designed ≥4.5:1
              accessible pair (WCAG 1.4.3) — the prior muted-on-muted chip
              failed contrast (review-run I6). */}
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-secondary-foreground">
            {sourceLabel}
          </span>
          <RelativeTime
            iso={timestamp}
            title={formatLocalisedTimestamp(timestamp, locale)}
            className="text-xs text-muted-foreground"
            locale={locale}
          />
        </div>
        {payloadDetail && (
          <p className="text-sm text-muted-foreground">{payloadDetail}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {tTimeline('actorBy', { actor: actorDisplay })}
        </p>
      </div>
    </div>
  );
}
