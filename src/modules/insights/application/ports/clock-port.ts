/**
 * F9 `ClockPort` Application port — an injectable wall clock so use-cases stay
 * deterministic in tests. Mirrors the per-module clock-port convention
 * (invoicing / members / payments / renewals / broadcasts).
 */
export interface ClockPort {
  now(): Date;
}
