/**
 * Renewals-by-month — pure Domain bucketing helpers + view-model types.
 *
 * Groups `renewal_cycles.expires_at` (timestamptz) into a fixed 14-bucket
 * planning window in the Asia/Bangkok wall-clock calendar: `overdue` ·
 * current month (m0) · next 11 months · `later`. Zero framework imports
 * (Constitution III) so both the server barrel and the client-safe barrel
 * can re-export the view-model types without dragging the server graph into
 * the browser bundle.
 *
 * Asia/Bangkok is a fixed UTC+7 offset (no DST), so month math is explicit
 * offset arithmetic — deterministic regardless of the host TZ the test or
 * server runs in (never a bare host-local `Date`).
 */

/** One SQL `to_char(... 'YYYY-MM')` group row from the aggregation. */
export interface RawMonthCount {
  readonly month: string;
  readonly count: number;
}

/** Repo aggregation output — already folded into overdue / window / later. */
export interface RenewalMonthAggregation {
  readonly overdueCount: number;
  readonly months: readonly RawMonthCount[];
  readonly laterCount: number;
}

/** One rendered bucket. `key ∈ 'overdue' | 'YYYY-MM' | 'later'`. */
export interface RenewalMonthBucket {
  readonly key: string;
  readonly count: number;
}

/** The full chart view-model: 14 ordered buckets + scaling denominator + total. */
export interface RenewalMonthSummary {
  readonly buckets: readonly RenewalMonthBucket[];
  readonly maxCount: number;
  readonly totalCount: number;
}

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ISO instant → its Asia/Bangkok wall-clock `'YYYY-MM'`. */
export function bkkYearMonth(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + BKK_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** `'YYYY-MM'` + n months → `'YYYY-MM'` (n may be negative). */
export function addMonthsToYm(ym: string, n: number): string {
  const [ys, ms] = ym.split('-');
  const total = Number(ys) * 12 + (Number(ms) - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** The UTC instant corresponding to the 1st of `ym` at 00:00 Asia/Bangkok. */
export function bkkMonthStartInstant(ym: string): Date {
  return new Date(`${ym}-01T00:00:00+07:00`);
}

/** 12 chronological `'YYYY-MM'` keys, current BKK month first. */
export function buildMonthWindow(nowIso: string): string[] {
  const start = bkkYearMonth(nowIso);
  return Array.from({ length: 12 }, (_, i) => addMonthsToYm(start, i));
}

/**
 * Fold raw `to_char`-grouped month counts into overdue / in-window / later
 * relative to the BKK current month. String comparison on `'YYYY-MM'` is
 * lexicographically correct for a fixed-width same-format key.
 */
export function foldRawMonths(
  raw: readonly RawMonthCount[],
  nowIso: string,
): RenewalMonthAggregation {
  const currentYm = bkkYearMonth(nowIso);
  const laterYm = addMonthsToYm(currentYm, 12);
  let overdueCount = 0;
  let laterCount = 0;
  const months: RawMonthCount[] = [];
  for (const r of raw) {
    if (r.month < currentYm) overdueCount += r.count;
    else if (r.month >= laterYm) laterCount += r.count;
    else months.push({ month: r.month, count: r.count });
  }
  return { overdueCount, months, laterCount };
}

/** Assemble the ordered, zero-filled 14-bucket view-model. */
export function buildRenewalMonthSummary(
  agg: RenewalMonthAggregation,
  nowIso: string,
): RenewalMonthSummary {
  const window = buildMonthWindow(nowIso);
  const monthMap = new Map(agg.months.map((m) => [m.month, m.count]));
  const buckets: RenewalMonthBucket[] = [
    { key: 'overdue', count: agg.overdueCount },
    ...window.map((ym) => ({ key: ym, count: monthMap.get(ym) ?? 0 })),
    { key: 'later', count: agg.laterCount },
  ];
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const totalCount = buckets.reduce((s, b) => s + b.count, 0);
  return { buckets, maxCount, totalCount };
}

/**
 * Validate a raw `?month` param: `'overdue'` / `'later'` / strict `YYYY-MM`
 * (rejects `2026-13` / `2026-00`). Invalid → null (caller treats as absent).
 */
export function parseMonthParam(raw: string | undefined | null): string | null {
  if (raw === 'overdue' || raw === 'later') return raw;
  if (typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw;
  return null;
}

/** Nonzero bars floor to this %, so a dominated bucket is still visible. */
export const MIN_BAR_PERCENT = 4;

/** Bar fill percent (0–100). Nonzero clamps up to `MIN_BAR_PERCENT`. */
export function barWidthPercent(count: number, maxCount: number): number {
  if (maxCount <= 0 || count <= 0) return 0;
  return Math.min(100, Math.max(MIN_BAR_PERCENT, (count / maxCount) * 100));
}
