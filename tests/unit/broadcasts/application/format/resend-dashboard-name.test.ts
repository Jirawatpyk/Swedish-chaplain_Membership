import { describe, expect, it } from 'vitest';
import { resendDashboardName } from '@/modules/broadcasts/application/format/resend-dashboard-name';

describe('resendDashboardName', () => {
  it('caps a long fromName + long subject to <= 70 code points', () => {
    const name = resendDashboardName('E2E Alpha Co via Thai-Swedish Chamber of Commerce', 'F7 Verify — E-Blast live send (test)');
    expect([...name].length).toBeLessThanOrEqual(70);
    expect(name.startsWith('E2E Alpha Co via')).toBe(true);
  });

  it('measures in code points, not UTF-16 units, and never splits a surrogate pair', () => {
    const subject = '😀'.repeat(80); // 80 emoji = 160 UTF-16 units, 80 code points
    const name = resendDashboardName('Tenant', subject);
    expect([...name].length).toBeLessThanOrEqual(70);
    // No lone surrogate (would render as replacement glyph): re-encoding round-trips.
    expect([...name].every((cp) => cp.length === 2 || cp.length === 1)).toBe(true);
    expect(name.includes('�')).toBe(false);
  });

  it('leaves a short label unchanged', () => {
    expect(resendDashboardName('SweCham', 'Welcome')).toBe('SweCham — Welcome');
  });
});
