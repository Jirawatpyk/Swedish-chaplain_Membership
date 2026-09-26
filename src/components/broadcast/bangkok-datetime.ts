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
 *
 * `Intl`-only on purpose: this module ships to the browser (schedule
 * picker, approve / schedule-confirm dialogs), and js-joda's tz database
 * (`@js-joda/timezone`) is an un-tree-shakeable ~900 KB side effect. The
 * results match the previous js-joda implementation exactly — pinned by the
 * parity tests in `tests/unit/broadcast/bangkok-datetime.test.ts` — and the
 * bundle stays clean per
 * `tests/unit/architecture/broadcast-client-no-js-joda.test.ts`.
 */

const BANGKOK_TZ = 'Asia/Bangkok';

const MS_PER_DAY = 86_400_000;

/**
 * `YYYY-MM-DDTHH:mm[:ss[.fffffffff]]` — the ISO local date-time shapes
 * js-joda's `LocalDateTime.parse` accepted: a 4-digit year, `-` plus 4–9
 * digits, or `+` plus 5–9 digits (`+2026` is rejected); a bare trailing
 * `.` is allowed.
 */
const LOCAL_DATE_TIME =
  /^(\+\d{5,9}|-\d{4,9}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{0,9}))?)?$/;

/** Largest |epoch ms| a JS `Date` can hold. */
const MAX_DATE_MS = 8.64e15;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Epoch ms of the given fields read as UTC, in plain arithmetic (proleptic
 * Gregorian, days-from-civil) — unlike `Date.UTC` it maps years 0–99
 * literally and stays finite past the `Date` range, so wall-times at the
 * very ends of that range still resolve like js-joda did.
 */
function utcEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDay = era * 146_097 + dayOfEra - 719_468;
  return epochDay * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + ms;
}

const zoneFieldsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BANGKOK_TZ,
  hourCycle: 'h23',
  era: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/**
 * Bangkok's UTC offset (ms, second precision) at the instant `epochMs`,
 * clamped into the `Date` range (the offset is constant at both ends).
 */
function bangkokOffsetMs(epochMs: number): number {
  const clamped = Math.min(Math.max(epochMs, -MAX_DATE_MS), MAX_DATE_MS);
  const wholeSecond = Math.floor(clamped / 1000) * 1000;
  const parts = zoneFieldsFormatter.formatToParts(new Date(wholeSecond));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const era = parts.find((p) => p.type === 'era')?.value;
  const year = era === 'BC' || era === 'B' ? 1 - get('year') : get('year');
  const wall = utcEpochMs(
    year,
    get('month'),
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
    0,
  );
  return wall - wholeSecond;
}

/**
 * The instant at which Bangkok wall-clock reads `wallAsUtcMs` (the wall
 * fields encoded as if they were UTC). Same resolution as js-joda's
 * `LocalDateTime.atZone`: in an overlap the earlier offset wins; in a gap
 * the wall-time is shifted forward by the gap length.
 */
function bangkokWallToEpochMs(wallAsUtcMs: number): number {
  const offsetBefore = bangkokOffsetMs(wallAsUtcMs - MS_PER_DAY);
  const early = wallAsUtcMs - offsetBefore;
  if (bangkokOffsetMs(early) === offsetBefore) return early;
  const offsetAfter = bangkokOffsetMs(wallAsUtcMs + MS_PER_DAY);
  const late = wallAsUtcMs - offsetAfter;
  if (bangkokOffsetMs(late) === offsetAfter) return late;
  return early; // gap
}

/**
 * Convert a naive `<input type="datetime-local">` value (interpreted as
 * Bangkok wall-time) to a UTC ISO-8601 string.
 *
 * Returns `null` for empty / unparseable input — including impossible
 * dates such as `2026-02-30` — so callers can preserve the existing
 * `value: string | null` contract used by the picker.
 */
export function bangkokInputToIso(local: string): string | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (m === null) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const epochMs = bangkokWallToEpochMs(utcEpochMs(year, month, day, hour, minute, second, ms));
  return Math.abs(epochMs) <= MAX_DATE_MS ? new Date(epochMs).toISOString() : null;
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
  // Format ms instant as Bangkok wall-time via Intl (a pinned timeZone is
  // the canonical browser-safe way).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANGKOK_TZ,
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
  // Asia/Bangkok has no DST, so "instant + N min" and "wall-time + N min"
  // are the same wall-clock reading; seconds are dropped by the formatter.
  return isoToBangkokInput(new Date(Date.now() + plusMinutes * 60_000).toISOString());
}
