/**
 * FR-008 — Thai Alumni age eligibility.
 *
 * When a member enrolls on the Thai Alumni plan, their **primary contact**
 * must be ≤ 35 years old AT PLAN START DATE. The primary contact's DOB
 * is collected only for this tier (Q5 — see data-model.md § 1.2).
 *
 * Measured in whole years (not months/days) — the intent is "35 or under
 * on the first day of the plan year", matching how alumni eligibility is
 * traditionally checked.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

export type AgeEligibilityViolation = {
  code: 'age.over_max';
  ageYears: number;
  maxAge: number;
};

export const THAI_ALUMNI_MAX_AGE = 35;

/**
 * @param dateOfBirth Primary contact's DOB
 * @param planStartDate First day of the plan year
 * @param maxAge Inclusive upper bound (default 35 — Thai Alumni)
 */
export function checkAgeEligibility(
  dateOfBirth: Date,
  planStartDate: Date,
  maxAge: number = THAI_ALUMNI_MAX_AGE,
): Result<undefined, AgeEligibilityViolation> {
  const age = yearsBetween(dateOfBirth, planStartDate);
  if (age > maxAge)
    return err({ code: 'age.over_max', ageYears: age, maxAge });
  return ok(undefined);
}

function yearsBetween(earlier: Date, later: Date): number {
  let years = later.getUTCFullYear() - earlier.getUTCFullYear();
  const monthDelta = later.getUTCMonth() - earlier.getUTCMonth();
  const dayDelta = later.getUTCDate() - earlier.getUTCDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) years -= 1;
  return years;
}
