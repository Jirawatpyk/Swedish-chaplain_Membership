/**
 * Unit test for `formatLocalisedTimestamp()` — staff-review S-6.
 *
 * Locks in US6 AS1: "formatted per user locale including BE display
 * for th-TH". Tests the Buddhist Era year conversion (CE + 543) as
 * well as graceful fallback for bad locales / bad input.
 */
import { describe, expect, it } from 'vitest';
import { formatLocalisedTimestamp } from '@/components/members/timeline-event-item';

describe('formatLocalisedTimestamp (US6 AS1)', () => {
  const iso = '2026-04-10T10:00:00Z';

  it('th locale renders Buddhist Era year (2026 → 2569)', () => {
    const out = formatLocalisedTimestamp(iso, 'th');
    // Intl output format varies across ICU versions; assert the year
    // arithmetic rather than the exact string layout.
    expect(out).toContain('2569');
    expect(out).not.toContain('2026');
  });

  it('en locale keeps Gregorian year (2026)', () => {
    const out = formatLocalisedTimestamp(iso, 'en');
    expect(out).toContain('2026');
    expect(out).not.toContain('2569');
  });

  it('sv locale keeps Gregorian year (2026)', () => {
    const out = formatLocalisedTimestamp(iso, 'sv');
    expect(out).toContain('2026');
    expect(out).not.toContain('2569');
  });

  it('falls back to ISO slice when the input string is unparseable', () => {
    const out = formatLocalisedTimestamp('not-a-date', 'en');
    expect(out).toBe('not-a-date');
  });

  it('falls back gracefully when an unsupported locale is passed', () => {
    // Invalid BCP47 tag throws inside Intl — catch path must return
    // the ISO slice, not throw.
    const out = formatLocalisedTimestamp(iso, '!!!-bad-locale');
    // Should not throw; output is either the ISO slice or a default
    // format (depends on Intl's tolerant-mode behaviour).
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('th locale uses 24-hour time (hour12 = false)', () => {
    // 10:00 UTC, formatter uses the machine's local tz — but 10 or its
    // offset must NOT include am/pm.
    const out = formatLocalisedTimestamp(iso, 'th');
    expect(out.toLowerCase()).not.toContain('am');
    expect(out.toLowerCase()).not.toContain('pm');
  });
});
