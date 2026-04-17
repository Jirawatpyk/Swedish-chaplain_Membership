import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '@/lib/relative-time';

const NOW = new Date('2026-04-16T12:00:00Z');

describe('formatRelativeTime', () => {
  it('renders "just now" for timestamps < 10s ago', () => {
    const out = formatRelativeTime('2026-04-16T11:59:55Z', 'en', NOW);
    expect(out.toLowerCase()).toContain('now');
  });

  it('renders minutes ago for timestamps < 1h ago', () => {
    const out = formatRelativeTime('2026-04-16T11:30:00Z', 'en', NOW);
    expect(out).toContain('30');
    expect(out.toLowerCase()).toContain('minute');
  });

  it('renders hours ago for timestamps < 1d ago', () => {
    const out = formatRelativeTime('2026-04-16T06:00:00Z', 'en', NOW);
    expect(out).toContain('6');
    expect(out.toLowerCase()).toContain('hour');
  });

  it('renders days ago for timestamps < 30d ago', () => {
    const out = formatRelativeTime('2026-04-14T12:00:00Z', 'en', NOW);
    expect(out).toContain('2');
    expect(out.toLowerCase()).toContain('day');
  });

  it('falls back to absolute date for timestamps > 30d ago', () => {
    const out = formatRelativeTime('2026-01-01T00:00:00Z', 'en', NOW);
    expect(out).toContain('2026');
    expect(out).toContain('Jan');
  });

  it('renders Thai relative time for th locale (not English)', () => {
    const out = formatRelativeTime('2026-04-14T12:00:00Z', 'th', NOW);
    // Intl may produce "เมื่อวานซืน" (day before yesterday) or "2 วัน..."
    // — either is valid localised output. Key assertion: no English.
    expect(out).not.toContain('day');
    expect(out).not.toContain('ago');
    expect(out.length).toBeGreaterThan(0);
  });

  it('renders Thai BE year for old dates in th locale', () => {
    const out = formatRelativeTime('2025-01-01T00:00:00Z', 'th', NOW);
    expect(out).toContain('2568');
    expect(out).not.toContain('2025');
  });

  it('renders Swedish relative time for sv locale', () => {
    const out = formatRelativeTime('2026-04-16T10:00:00Z', 'sv', NOW);
    expect(out).toContain('2');
    // Swedish uses "timmar" for hours
    expect(out.toLowerCase()).toContain('tim');
  });

  it('returns raw ISO for unparseable input', () => {
    const out = formatRelativeTime('not-a-date', 'en', NOW);
    expect(out).toBe('not-a-date');
  });
});
