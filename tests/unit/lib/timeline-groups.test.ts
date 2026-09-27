/**
 * Spec 122 US3 — the timeline's day groups and times (Portal-timeline boards),
 * in Bangkok time with the Buddhist Era for Thai (display only).
 */
import { describe, expect, it } from 'vitest';
import { formatTimelineMonth, formatTimelineTime, timelineGroup } from '@/lib/timeline-groups';

// 27 Sep 2026, 10:00 in Bangkok
const NOW = new Date('2026-09-27T03:00:00.000Z');

describe('timeline groups', () => {
  it('puts an event in Today, This month or its own month, by the Bangkok calendar', () => {
    expect(timelineGroup('2026-09-27T01:00:00.000Z', NOW)).toEqual({ kind: 'today' });
    // 26 Sep 18:30 UTC is already 27 Sep 01:30 in Bangkok
    expect(timelineGroup('2026-09-26T18:30:00.000Z', NOW)).toEqual({ kind: 'today' });
    expect(timelineGroup('2026-09-26T16:00:00.000Z', NOW)).toEqual({ kind: 'thisMonth' });
    expect(timelineGroup('2026-07-03T02:00:00.000Z', NOW)).toEqual({ kind: 'month', month: '2026-07' });
    expect(timelineGroup('not-a-date', NOW)).toBeNull();
  });

  it('names an earlier month in the reader’s language, Buddhist Era for Thai', () => {
    expect(formatTimelineMonth('2026-07', 'en')).toBe('July 2026');
    expect(formatTimelineMonth('2026-07', 'th')).toContain('2569');
    expect(formatTimelineMonth('2026-07', 'th')).not.toContain('2026');
  });

  it('shows the time only under Today, else a short date and time', () => {
    expect(formatTimelineTime('2026-09-27T03:03:00.000Z', 'en', true)).toBe('10:03');
    const other = formatTimelineTime('2026-09-22T07:10:00.000Z', 'en', false);
    expect(other).toContain('22');
    expect(other).toContain('14:10');
  });
});
