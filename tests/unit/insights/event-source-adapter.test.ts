/**
 * F9 US4 (review-run M-6) — eventSourceAdapter.getCulturalConsumption.
 *
 * Pins the cultural-ticket consumption logic the integration test can't easily
 * isolate: (1) only event types containing "cultural" count (cultural +
 * partnership_and_cultural; general excluded), (2) the tenant-tz calendar-year
 * window excludes prior- and next-year attendances, (3) lastUsedAt = the max
 * in-window attendedAt. The events query port is mocked so we drive exact rows.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

const getAttendeesMock = vi.fn();

vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/modules/events', () => ({
  getEventAttendeesByMember: (...a: unknown[]) => getAttendeesMock(...a),
  drizzleEventAttendeesQuery: {},
}));
vi.mock('@/modules/members', () => ({
  asTenantId: (s: string) => s,
  asMemberId: (s: string) => s,
}));

import { eventSourceAdapter } from '@/modules/insights/infrastructure/sources/event-source-adapter';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;

describe('eventSourceAdapter.getCulturalConsumption (2026, Asia/Bangkok)', () => {
  it('counts only cultural-tagged, in-year attendances and reports the latest', async () => {
    getAttendeesMock.mockResolvedValueOnce([
      { attendedAt: '2026-03-15T00:00:00.000Z', eventType: 'cultural', eventId: 'e1', memberId: 'm1' },
      { attendedAt: '2026-06-01T00:00:00.000Z', eventType: 'partnership_and_cultural', eventId: 'e2', memberId: 'm1' },
      { attendedAt: '2026-04-01T00:00:00.000Z', eventType: 'general', eventId: 'e3', memberId: 'm1' }, // not cultural
      { attendedAt: '2025-12-15T00:00:00.000Z', eventType: 'cultural', eventId: 'e4', memberId: 'm1' }, // prior year
      { attendedAt: '2027-01-05T00:00:00.000Z', eventType: 'cultural', eventId: 'e5', memberId: 'm1' }, // next year
    ]);

    const r = await eventSourceAdapter.getCulturalConsumption(CTX, 'm1', 2026);

    expect(r.used).toBe(2); // the two in-year cultural rows
    expect(r.lastUsedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('no cultural attendances → used 0, lastUsedAt null', async () => {
    getAttendeesMock.mockResolvedValueOnce([
      { attendedAt: '2026-05-01T00:00:00.000Z', eventType: 'general', eventId: 'e1', memberId: 'm1' },
    ]);
    const r = await eventSourceAdapter.getCulturalConsumption(CTX, 'm1', 2026);
    expect(r.used).toBe(0);
    expect(r.lastUsedAt).toBeNull();
  });
});
