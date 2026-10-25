/**
 * What the proxy's kill switches are refusing right now, read from the same
 * flags `src/proxy.ts` reads: READ_ONLY_MODE (every write) and the F3/F4/F5/
 * F7/F8 feature switches. `/admin/support` and the staff maintenance banner
 * show it, so a staff user who was refused learns why without guessing.
 */
import { describe, expect, it } from 'vitest';
import { readPauseState } from '@/lib/pause-state';

const allOn = {
  flags: { readOnlyMode: false },
  features: {
    f3Members: true,
    f4Invoicing: true,
    f5OnlinePayment: true,
    f7Broadcasts: true,
    f8Renewals: true,
  },
};

describe('readPauseState', () => {
  it('reports nothing paused when writes are open and every switch is on', () => {
    expect(readPauseState(allOn)).toEqual({ readOnly: false, featuresOff: [] });
  });

  it('reports maintenance when READ_ONLY_MODE is on', () => {
    expect(readPauseState({ ...allOn, flags: { readOnlyMode: true } }).readOnly).toBe(true);
  });

  it('lists the switched-off features in a fixed order', () => {
    const state = readPauseState({
      ...allOn,
      features: { ...allOn.features, f7Broadcasts: false, f5OnlinePayment: false },
    });
    expect(state.featuresOff).toEqual(['onlinePayment', 'broadcasts']);
  });
});
