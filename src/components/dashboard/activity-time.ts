/**
 * F9 activity-feed timestamp labels.
 *
 * Produces the two labels the recent-activity feed needs from one UTC instant:
 *   - `relative` — the VISIBLE label ("5 minutes ago"), locale-aware (FR-003).
 *   - `absolute` — the exact date+time TOOLTIP, rendered in the tenant timezone.
 *
 * The absolute label MUST carry `timeZone` (the Vercel runtime is UTC): without
 * it a Bangkok tenant sees times 7h behind and the wrong day for events in the
 * 00:00–07:00 Bangkok window — the same pitfall the dashboard "as of" label
 * guards against.
 */
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { formatRelativeTime } from '@/lib/relative-time';

export interface ActivityTimeLabels {
  /** Visible, locale-aware relative label ("5 minutes ago"). */
  readonly relative: string;
  /** Exact date+time in the tenant timezone — used as the `<time>` tooltip. */
  readonly absolute: string;
}

export function activityTimeLabels(
  iso: string,
  locale: string,
  timeZone: string,
  now: Date = new Date(),
): ActivityTimeLabels {
  const relative = formatRelativeTime(iso, locale, now);
  const absolute = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
  return { relative, absolute };
}
