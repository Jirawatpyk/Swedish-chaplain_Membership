/**
 * T054 — Clock port (F5). Same shape as F4's ClockPort; separate file
 * so F5 Application does not cross-import from F4 Application deep path
 * (Principle III barrel-guard).
 */
export interface ClockPort {
  /** Current time as ISO-8601 UTC string. */
  nowIso(): string;
  /** Current time as epoch milliseconds. */
  nowMs(): number;
}

export const systemClock: ClockPort = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};
