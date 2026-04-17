/**
 * FR-007 — Start-up plan duration.
 *
 * A member enrolling on the "Start-up" tier must have `foundedYear` within
 * 2 years of `registrationDate.year`. Rationale: the tier exists to support
 * genuinely-new companies, not established firms shopping for a discount.
 *
 * An admin can override via OverrideReason; this policy only reports
 * whether the constraint is met.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

export type StartupDurationViolation = {
  code: 'startup.too_old';
  foundedYear: number;
  registrationYear: number;
  ageYears: number;
  maxAllowedYears: number;
};

export const STARTUP_MAX_AGE_YEARS = 2;

export function checkStartupDuration(
  foundedYear: number,
  registrationDate: Date,
  maxAllowedYears: number = STARTUP_MAX_AGE_YEARS,
): Result<undefined, StartupDurationViolation> {
  const registrationYear = registrationDate.getUTCFullYear();
  const ageYears = registrationYear - foundedYear;
  if (ageYears > maxAllowedYears)
    return err({
      code: 'startup.too_old',
      foundedYear,
      registrationYear,
      ageYears,
      maxAllowedYears,
    });
  return ok(undefined);
}
