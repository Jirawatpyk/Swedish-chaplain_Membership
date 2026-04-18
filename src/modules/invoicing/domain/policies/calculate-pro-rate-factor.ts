/**
 * T028 — Pro-rate factor policy (F4).
 *
 * Returns a Decimal-4 string (e.g. "0.7500") representing the fraction
 * of the annual membership fee that should be charged when issuing a
 * partial-period invoice.
 *
 * Policies (from `tenant_invoice_settings.pro_rate_policy`):
 *   - `none`    → factor = 1.0000 (always bill full annual fee)
 *   - `monthly` → factor = remainingMonths / 12, where remainingMonths
 *                  is the number of FULL calendar months from
 *                  issue_date inclusive to the end of the fiscal year
 *   - `daily`   → factor = remainingDays / 365, using the fiscal year's
 *                  actual length (365 or 366) and day-of-fy math
 *
 * Edge cases (from research.md § 7):
 *   - issue on FY start day → factor = 1.0000 (full period ahead)
 *   - issue on FY end day → factor = minimum non-zero (1 day remaining
 *     for daily; 1/12 for monthly when starting in the last month;
 *     0.0833 for monthly if issuing on FY-end day of the last month).
 *
 * The policy is a pure function over integers — no clock access, no
 * framework deps. Call sites pass in the resolved dates.
 */
import type { ProRatePolicy } from '@/modules/invoicing/domain/value-objects/pro-rate-policy';

export interface ProRateInputs {
  readonly policy: ProRatePolicy;
  /** ISO date string (YYYY-MM-DD) — first day of coverage. */
  readonly issueDate: string;
  /** ISO date string — first day of the fiscal year (Bangkok). */
  readonly fyStartDate: string;
  /** ISO date string — last day of the fiscal year (Bangkok, inclusive). */
  readonly fyEndDate: string;
}

function daysBetween(isoA: string, isoB: string): number {
  const a = Date.UTC(
    Number(isoA.slice(0, 4)),
    Number(isoA.slice(5, 7)) - 1,
    Number(isoA.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(isoB.slice(0, 4)),
    Number(isoB.slice(5, 7)) - 1,
    Number(isoB.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

function monthIndex(iso: string): number {
  // YYYY-MM → year*12 + (month-1)
  return Number(iso.slice(0, 4)) * 12 + (Number(iso.slice(5, 7)) - 1);
}

function fourDp(n: number): string {
  // Clamp + format to 4 decimals without JS float noise.
  const clamped = Math.max(0, Math.min(1, n));
  return clamped.toFixed(4);
}

export function calculateProRateFactor(inputs: ProRateInputs): string {
  const { policy, issueDate, fyStartDate, fyEndDate } = inputs;
  if (policy === 'none') return '1.0000';

  if (policy === 'monthly') {
    // Remaining months from issue month (inclusive) to FY end month (inclusive).
    const fyStartM = monthIndex(fyStartDate);
    const issueM = monthIndex(issueDate);
    const fyEndM = monthIndex(fyEndDate);
    const totalMonths = fyEndM - fyStartM + 1; // normally 12
    const remaining = Math.max(0, fyEndM - issueM + 1);
    return fourDp(remaining / totalMonths);
  }

  // daily
  const totalDays = daysBetween(fyStartDate, fyEndDate) + 1; // inclusive
  const remaining = Math.max(0, daysBetween(issueDate, fyEndDate) + 1);
  return fourDp(remaining / totalDays);
}
