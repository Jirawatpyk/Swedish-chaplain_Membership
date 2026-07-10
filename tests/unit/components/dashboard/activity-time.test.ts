/**
 * F9 activity-feed timestamp labels (dashboard bug hunt 2026-07-11).
 *
 * Bug 3: the feed formatted absolute timestamps with no `timeZone`, so on the
 * UTC Vercel runtime a Bangkok tenant saw times 7h behind (and the wrong day
 * for events in the 00:00–07:00 Bangkok window). The absolute label must be
 * rendered in the tenant timezone.
 *
 * Bug 7 (relative-time gap): the visible label must be a relative time
 * ("5 minutes ago"), not an absolute date+time — the absolute is the tooltip.
 */
import { describe, expect, it } from 'vitest';
import { activityTimeLabels } from '@/components/dashboard/activity-time';

describe('activityTimeLabels — absolute label honours the tenant timezone (bug 3)', () => {
  // 2026-07-10T22:00:00Z is 2026-07-11 05:00 in Asia/Bangkok (+07:00): the
  // tenant-tz label must show the 11th, not the 10th 22:00.
  const iso = '2026-07-10T22:00:00.000Z';

  it('formats the absolute label in Asia/Bangkok, not the UTC runtime clock', () => {
    const bangkok = activityTimeLabels(iso, 'en', 'Asia/Bangkok').absolute;
    const utc = activityTimeLabels(iso, 'en', 'UTC').absolute;

    // Bangkok is a calendar day ahead of the UTC-runtime rendering here.
    expect(bangkok).not.toBe(utc);
    expect(bangkok).toMatch(/11/); // 11 Jul (Bangkok)
    expect(utc).toMatch(/10/); // 10 Jul (UTC)
  });
});

describe('activityTimeLabels — visible label is relative (bug 7)', () => {
  it('produces a relative label distinct from the absolute one', () => {
    const now = new Date('2026-07-11T00:05:00.000Z');
    const { relative, absolute } = activityTimeLabels(
      '2026-07-11T00:00:00.000Z', // 5 minutes before `now`
      'en',
      'Asia/Bangkok',
      now,
    );

    // Relative time is not the same string as the absolute date+time, and it
    // reflects the 5-minute delta.
    expect(relative).not.toBe(absolute);
    expect(relative).toMatch(/5|minute/i);
  });
});
