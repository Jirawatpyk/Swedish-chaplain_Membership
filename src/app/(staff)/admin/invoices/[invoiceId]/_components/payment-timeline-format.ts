/**
 * Pure date-formatting helper for the payment timeline.
 *
 * Extracted from `payment-timeline.tsx` so unit tests can import
 * this single function without pulling the full Server Component
 * graph (next-intl/server, userRepo, cached-payment-activity, etc.).
 *
 * No React, no next-intl, no component imports — only the shared
 * locale helper from `@/lib/format-date-localised`.
 */
import { getDateFormatLocale } from '@/lib/format-date-localised';

/**
 * Format an event timestamp for display on the payment timeline.
 *
 * BE via `getDateFormatLocale` (explicit `th-TH-u-ca-buddhist`;
 * not ICU-default — constitution § Conventions: BE is display-only).
 * Pins to `Asia/Bangkok` so Bangkok payment events are not rendered
 * ~7h off when the server runs in UTC (S1-P1-20).
 * Storage stays ISO UTC; this helper is display-only.
 */
export function formatTimestamp(date: Date, locale: string): string {
  return date.toLocaleString(getDateFormatLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'Asia/Bangkok',
  });
}
