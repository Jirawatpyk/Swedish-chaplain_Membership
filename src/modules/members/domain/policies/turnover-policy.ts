/**
 * FR-006 — turnover vs plan band.
 *
 * Compares `member.turnoverThb` against a plan's (min, max) turnover band
 * expressed in **THB** integer. The Application layer adapts the F2 plan
 * object (which carries minor-units in the plan's currency) before calling
 * this — Domain doesn't know about money or currencies.
 *
 * Returns a severity so the UI can show either a hard block (override
 * required via OverrideReason) or a non-blocking notice. F3 treats
 * outside-band as a WARNING that requires override (FR-006a); fully-missing
 * turnover is allowed (band check only fires when the field is present).
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

export type TurnoverBand = {
  readonly minThb: number | null;
  readonly maxThb: number | null;
};

export type TurnoverViolation = {
  code: 'turnover.outside_band';
  turnoverThb: number;
  band: TurnoverBand;
};

export function checkTurnoverBand(
  turnoverThb: number | null,
  band: TurnoverBand,
): Result<undefined, TurnoverViolation> {
  if (turnoverThb === null) return ok(undefined);
  if (band.minThb !== null && turnoverThb < band.minThb)
    return err({ code: 'turnover.outside_band', turnoverThb, band });
  if (band.maxThb !== null && turnoverThb > band.maxThb)
    return err({ code: 'turnover.outside_band', turnoverThb, band });
  return ok(undefined);
}
