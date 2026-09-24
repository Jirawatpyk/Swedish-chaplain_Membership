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
import type { Payment } from '@/modules/payments';

/**
 * A payment status that implies the payment SUCCEEDED (was captured) at some
 * point: `succeeded`, or `partially_refunded`/`refunded` (a refund presupposes
 * a captured payment). `auto_refunded` is deliberately EXCLUDED — that path
 * reverses a stale/late capture and never marked the invoice paid.
 */
export function isSucceededLike(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'partially_refunded' ||
    status === 'refunded'
  );
}

/**
 * The most recently completed payment that succeeded at some point — the
 * canonical processor reference (charge-id row, "View in Stripe", the online
 * rail in Payment details). Uses {@link isSucceededLike} so a partial or full
 * refund does not hide the charge staff need to reconcile it.
 */
export function latestSucceededPayment(
  payments: readonly Payment[],
): Payment | undefined {
  return payments
    .filter((p) => isSucceededLike(p.status))
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    )[0];
}

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
  // docs/ux-standards.md § 12.3 — English reads en-GB (day-first, 24-hour:
  // "23 Sept 2026, 14:10"), not the en-US "Sep 23, 2026, 02:10 PM".
  const formatLocale = locale === 'en' ? 'en-GB' : getDateFormatLocale(locale);
  return date.toLocaleString(formatLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    timeZone: 'Asia/Bangkok',
  });
}
