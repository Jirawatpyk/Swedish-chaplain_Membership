/**
 * 124 invoice dashboard — fiscal-year date ranges and the 12 month slots of
 * the "Invoiced vs collected" chart (spec US3.3, § Figure definitions).
 * Pure, no framework imports.
 *
 * FY `n` starts on the 1st of `fiscal_year_start_month` of calendar year `n`
 * (Bangkok), the convention of `src/lib/fiscal-year.ts`; the current FY comes
 * from `deriveFiscalYear(nowIso, startMonth)` there. Filters are DATE ranges
 * (`issue_date` for Billed, the tax point for Collected), never
 * `invoices.fiscal_year`. Ranges are inclusive on both ends; clamping the
 * current FY to "to date" is the caller's.
 */
import { addDays, type FiscalYearStartMonth } from '@/lib/fiscal-year';

export interface FiscalYearDateRange {
  readonly fiscalYear: number;
  /** First day, `YYYY-MM-DD`, inclusive. */
  readonly from: string;
  /** Last day, `YYYY-MM-DD`, inclusive. */
  readonly to: string;
}

/** past = finished; current = in progress (holds `today`); future = still to come. */
export type FiscalMonthSlotState = 'past' | 'current' | 'future';

export interface FiscalMonthSlot {
  /** `YYYY-MM`. */
  readonly monthKey: string;
  readonly from: string;
  readonly to: string;
  readonly state: FiscalMonthSlotState;
}

function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** The calendar month holding `ymd` (`YYYY-MM-DD`), first to last day, inclusive. */
export function calendarMonthRange(ymd: string): { readonly from: string; readonly to: string } {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  // Day 0 of the next month (0-based `month`) is this month's last day.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = firstOfMonth(year, month);
  return { from, to: `${from.slice(0, 8)}${String(lastDay).padStart(2, '0')}` };
}

/** The (year, month) `offset` months after (year, startMonth). Integer math only. */
function monthAt(year: number, startMonth: number, offset: number): { year: number; month: number } {
  const zeroBased = startMonth - 1 + offset;
  return { year: year + Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

export function fiscalYearDateRange(
  fiscalYear: number,
  startMonth: FiscalYearStartMonth,
): FiscalYearDateRange {
  return {
    fiscalYear,
    from: firstOfMonth(fiscalYear, startMonth),
    to: addDays(firstOfMonth(fiscalYear + 1, startMonth), -1),
  };
}

/** The FY's 12 month slots, oldest first, each marked against Bangkok `today` (`YYYY-MM-DD`). */
export function fiscalYearMonthSlots(
  fiscalYear: number,
  startMonth: FiscalYearStartMonth,
  today: string,
): FiscalMonthSlot[] {
  const todayKey = today.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => {
    const { year, month } = monthAt(fiscalYear, startMonth, i);
    const next = monthAt(fiscalYear, startMonth, i + 1);
    const from = firstOfMonth(year, month);
    const monthKey = from.slice(0, 7);
    const state: FiscalMonthSlotState =
      monthKey < todayKey ? 'past' : monthKey === todayKey ? 'current' : 'future';
    return { monthKey, from, to: addDays(firstOfMonth(next.year, next.month), -1), state };
  });
}
