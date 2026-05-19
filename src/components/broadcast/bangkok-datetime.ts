/**
 * F7 UX hardening — E2: Bangkok wall-time helpers for the member-facing
 * schedule picker.
 *
 * `<input type="datetime-local">` returns a naive `YYYY-MM-DDTHH:mm`
 * string with NO timezone offset. The buggy pre-hardening code used
 * `new Date(localString)` which interprets the value in the BROWSER's
 * local TZ. F7 microcopy + admin approve dialog already pin the
 * scheduling contract to Bangkok wall-time; this helper restores parity
 * for the member-side compose surface so a member on a non-Bangkok
 * browser (e.g. VPN, traveller, UTC-set OS) doesn't accidentally
 * schedule a broadcast for the wrong wall-clock hour.
 *
 * Mirrors the inline pattern in
 * `src/components/broadcast/admin/approve-dialog.tsx:46-54` but lives
 * here so it is unit-testable and re-usable.
 *
 * Pure utility — no React / Next.js imports — so any test environment
 * or server component can consume it identically.
 */
import { LocalDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';

const BANGKOK_ZONE = ZoneId.of('Asia/Bangkok');

/**
 * Convert a naive `<input type="datetime-local">` value (interpreted as
 * Bangkok wall-time) to a UTC ISO-8601 string.
 *
 * Returns `null` for empty / unparseable input so callers can preserve
 * the existing `value: string | null` contract used by the picker.
 */
export function bangkokInputToIso(local: string): string | null {
  if (local === '') return null;
  // `<input type="datetime-local">` may include `:ss` if the browser
  // emits seconds (when `step` < 60). Normalise to a fixed shape that
  // `LocalDateTime.parse` accepts.
  const normalised = local.length === 16 ? `${local}:00` : local;
  try {
    const wall = LocalDateTime.parse(normalised);
    const instant = wall.atZone(BANGKOK_ZONE).toInstant();
    return new Date(instant.toEpochMilli()).toISOString();
  } catch {
    return null;
  }
}

/**
 * Render a UTC ISO-8601 instant back into the
 * `YYYY-MM-DDTHH:mm` shape expected by `<input type="datetime-local">`,
 * formatted as Bangkok wall-time.
 *
 * Round-trip: `isoToBangkokInput(bangkokInputToIso(local)!) === local`
 * for any well-formed wall-time string.
 */
export function isoToBangkokInput(iso: string | null): string {
  if (iso === null) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  // Format ms instant as Bangkok wall-time via Intl (avoids re-parsing
  // through @js-joda Instant just to re-extract fields — Intl with a
  // pinned timeZone is the canonical browser-safe way).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  // Intl `hour: '2-digit', hour12: false` can return "24" for midnight
  // on Node versions where the `hourCycle` defaults differ; coerce.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Compute the minimum acceptable `<input type="datetime-local">` value
 * as "now + N minutes" expressed in Bangkok wall-time. Used for the
 * client-side `min=` attribute defence; the server enforces the same
 * floor authoritatively (per FR-014a, NFR-PERF-002 lead-time).
 */
export function bangkokMinInputAfterMinutes(plusMinutes: number): string {
  const future = LocalDateTime.now(BANGKOK_ZONE).plusMinutes(plusMinutes);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${future.year()}-${pad(future.monthValue())}-${pad(future.dayOfMonth())}T${pad(future.hour())}:${pad(future.minute())}`;
}
