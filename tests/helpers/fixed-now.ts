/**
 * The instant `tests/setup.ts` pins the unit-test clock to. A test that moves
 * the clock with `vi.setSystemTime(...)` restores it with this value, so a
 * change to the pinned instant lands in one place.
 */
export const FIXED_NOW = new Date('2026-04-09T12:00:00.000Z');
