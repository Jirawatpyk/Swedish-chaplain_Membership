/**
 * Spec 122 US12c-1 (parity, 20 Oct; board `Admin-broadcast-review-mobile`) —
 * the phone bar's status line says how long the E-Blast has sat in its stage
 * ("17 hours in stage"): whole minutes under an hour, whole hours under two
 * days, whole days after, in the viewer's language.
 */
import { describe, expect, it } from 'vitest';
import { formatStageDuration } from '@/components/broadcast/admin/stage-duration';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('formatStageDuration', () => {
  it.each([
    [12, '12 minutes'],
    [60, '1 hour'],
    [17 * 60 + 40, '17 hours'],
    [47 * 60, '47 hours'],
    [48 * 60, '2 days'],
    [9 * 1440, '9 days'],
  ])('%i minutes reads "%s"', (minutes, label) => {
    expect(formatStageDuration(ago(minutes), NOW, 'en')).toBe(label);
  });

  it('never goes negative when the clock is behind the stage time', () => {
    expect(formatStageDuration(new Date(NOW.getTime() + 5 * 60_000), NOW, 'en')).toBe('0 minutes');
  });

  it('speaks Thai and Swedish', () => {
    expect(formatStageDuration(ago(17 * 60), NOW, 'th')).toMatch(/17\s*ชั่วโมง/);
    expect(formatStageDuration(ago(17 * 60), NOW, 'sv')).toBe('17 timmar');
  });
});
