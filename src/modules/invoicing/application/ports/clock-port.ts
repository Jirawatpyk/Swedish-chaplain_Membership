/**
 * T032 — Clock port (F4).
 * Abstracts wall-clock access so unit tests can inject deterministic times.
 */
export interface ClockPort {
  /** Returns current time as ISO-8601 UTC string. */
  nowIso(): string;
}

export const systemClock: ClockPort = {
  nowIso: () => new Date().toISOString(),
};
