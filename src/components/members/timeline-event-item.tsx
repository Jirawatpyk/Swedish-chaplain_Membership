/**
 * T132 — Timeline event item (US6).
 *
 * Renders a single audit event row with:
 *   - Localised event-type label
 *   - Human-readable actor attribution (resolved display name or "System")
 *   - Localised timestamp
 *   - Meaningful payload diff/summary (not raw UUIDs)
 *
 * FR-024: keyboard-accessible, aria-labelled, reduced-motion friendly.
 */

import { useTranslations, useLocale } from 'next-intl';
import { RelativeTime } from '@/components/ui/relative-time';

export type TimelineItemProps = {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly actorUserId: string;
  readonly actorDisplayName: string | null;
  readonly payload: Record<string, unknown> | null;
};

const SYSTEM_ACTORS = new Set(['system', 'system:bootstrap', 'anonymous']);

/**
 * Locale-aware timestamp formatter (US6 AS1).
 *
 * Constitution § Conventions requires Thai Buddhist Era (BE = CE + 543)
 * for `th-TH` display surfaces. Intl.DateTimeFormat supports it natively
 * via the `-u-ca-buddhist` locale extension.
 *
 * Other locales (`en`, `sv`) use Gregorian — standard for audit logs.
 * We keep the ISO string in `<time dateTime>` for machine-readable
 * access + screen readers; the rendered text is purely visual.
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
    // Fallback — bad locale, degrade to ISO slice
    return iso.replace('T', ' ').slice(0, 16);
  }
}

/**
 * Format the payload into a compact, human-readable one-liner.
 * Avoids showing raw UUIDs unless they are the actual target of the event.
 * Returns null when nothing useful to show — UI falls back to the
 * localised event-type heading alone.
 *
 * `tPayload` is the localised `admin.members.timeline.payload.*` namespace
 * so secondary labels are i18n'd consistently with the rest of the UI.
 */
function formatPayload(
  eventType: string,
  payload: Record<string, unknown> | null,
  tPayload: (key: 'primary' | 'primaryContactPromoted') => string,
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
    case 'member_updated': {
      const fields = payload.fields_changed;
      if (Array.isArray(fields) && fields.length > 0) {
        return `${fields.join(', ')}`;
      }
      return null;
    }
    case 'member_plan_changed': {
      // Prefer resolved plan display names (server-enriched) over raw UUIDs.
      const oldName = get('old_plan_name');
      const newName = get('new_plan_name');
      if (oldName && newName) return `${oldName} → ${newName}`;
      // Fallback: truncate UUIDs for pre-enrichment rows.
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
    case 'contact_created':
    case 'contact_updated':
    case 'contact_removed': {
      const fields = payload.fields_changed;
      if (Array.isArray(fields) && fields.length > 0) {
        return `${fields.join(', ')}`;
      }
      const isPrimary = payload.is_primary;
      if (isPrimary === true) return tPayload('primary');
      return null;
    }
    case 'member_self_updated': {
      const fields = payload.fields_changed;
      if (Array.isArray(fields) && fields.length > 0) {
        return `${fields.join(', ')}`;
      }
      return null;
    }
    case 'member_primary_contact_changed': {
      return tPayload('primaryContactPromoted');
    }
    case 'member_archived':
    case 'member_undeleted':
      return null; // Event type label is self-explanatory
    default:
      return null;
  }
}

export function TimelineEventItem({
  timestamp,
  eventType,
  actorUserId,
  actorDisplayName,
  payload,
}: TimelineItemProps) {
  const t = useTranslations('admin.members.timeline');
  const tPayload = useTranslations('admin.members.timeline.payload');
  const tEvent = useTranslations('audit.eventType');
  const locale = useLocale();

  // Defensive: event types not yet in the translation map fall back to
  // the raw enum key rather than throwing (audit log may ship new types
  // ahead of i18n keys during rollouts).
  let eventLabel: string;
  try {
    eventLabel = tEvent(eventType);
  } catch {
    eventLabel = eventType;
  }

  const actorDisplay = SYSTEM_ACTORS.has(actorUserId)
    ? t('actorSystem')
    : (actorDisplayName ?? t('actorSystem'));

  const payloadDetail = formatPayload(eventType, payload, tPayload);

  return (
    <li
      className="relative border-l-2 border-muted pl-6 py-3"
      data-event-type={eventType}
    >
      {/* Dot marker — reduced-motion friendly (static, no pulse) */}
      <span
        aria-hidden
        className="absolute -left-[5px] top-5 h-2 w-2 rounded-full bg-primary"
      />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-sm">{eventLabel}</span>
          {/* Root-cause hydration fix: `<RelativeTime>` renders a
              stable absolute date during SSR + first paint, then
              flips to the "X seconds ago" relative-time string after
              `useEffect` runs (client-only). Replaces the previous
              `suppressHydrationWarning` pattern. */}
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
          {t('actor', { actor: actorDisplay })}
        </p>
      </div>
    </li>
  );
}
