/**
 * #54 — /admin/invoices/new loads only the newest 200 events, and the
 * event-fee form preselects a deep-linked event only when it is in that list.
 * A deep link (?eventRegistrationId=…) to a registration on an older event
 * then landed on an empty Event tab. The page now adds the deep-linked event
 * to the options when it is missing; these pin that step and the label.
 */
import { describe, expect, it } from 'vitest';
import {
  toEventOption,
  withDeepLinkedEvent,
} from '@/app/(staff)/admin/invoices/new/_lib/event-options';

const LISTED = [
  { eventId: 'evt-new', label: 'Gala (2026-12-01)' },
  { eventId: 'evt-mid', label: 'Mixer (2026-11-15)' },
] as const;

describe('withDeepLinkedEvent', () => {
  it('returns the same list when the deep-linked event is already in it', () => {
    const out = withDeepLinkedEvent(LISTED, { eventId: 'evt-mid', label: 'Mixer (2026-11-15)' });
    expect(out).toBe(LISTED);
  });

  it('appends a deep-linked event the list does not hold, once, at the end', () => {
    const old = { eventId: 'evt-old', label: 'Breakfast (2025-03-04)' };
    const out = withDeepLinkedEvent(LISTED, old);
    expect(out).toEqual([...LISTED, old]);
    expect(out.filter((e) => e.eventId === 'evt-old')).toHaveLength(1);
  });

  it('returns the same list when there is no deep-linked event', () => {
    expect(withDeepLinkedEvent(LISTED, null)).toBe(LISTED);
  });
});

describe('toEventOption', () => {
  it('labels the event with its name and Bangkok CE start date', () => {
    expect(
      toEventOption({ eventId: 'evt-1', name: 'Breakfast', startDateIso: '2025-03-04T02:00:00.000Z' }),
    ).toEqual({ eventId: 'evt-1', label: 'Breakfast (2025-03-04)' });
  });

  it('a UTC instant late in the day falls on the next Bangkok day', () => {
    expect(
      toEventOption({ eventId: 'evt-2', name: 'Night', startDateIso: '2025-03-04T18:30:00.000Z' }).label,
    ).toBe('Night (2025-03-05)');
  });
});
