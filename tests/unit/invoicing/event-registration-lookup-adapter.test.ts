/**
 * Task 5 (054-event-fee-invoices) — unit test for the invoicing
 * event-registration-lookup adapter's aggregate → view mapping.
 *
 * The live-Neon cross-tenant test
 * (tests/integration/invoicing/event-registration-lookup-cross-tenant.test.ts)
 * proves the RLS data-isolation property. This unit test pins the pure
 * branded → primitive mapping (ids, attendee fields, ticket, match,
 * pseudonymised flag) + the err-branch translation, with the F6 barrel
 * lookup mocked so we drive exact aggregates without a DB.
 */
import { describe, it, expect, vi } from 'vitest';

const findByIdMock = vi.fn();

vi.mock('@/modules/events', () => ({
  asTenantId: (s: string) => s,
  asRegistrationId: (s: string) => s,
  makeEventRegistrationLookupForTenant: () => ({ findById: findByIdMock }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

// Minimal hand-built aggregate shaped like an F6 EventRegistrationAggregate.
// Branded fields are plain strings at runtime; the cast satisfies the
// adapter's `String(...)` un-branding path.
function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    registrationId: 'reg-uuid-1',
    eventId: 'event-uuid-1',
    externalId: 'att_ext_1',
    attendee: {
      email: 'guest@example.com',
      name: 'Guest Name',
      company: 'Guest Co',
    },
    match: { type: 'non_member', matchedMemberId: null, matchedContactId: null },
    ticket: { type: 'VIP', priceThb: 2500, paymentStatus: 'paid' },
    quotaEffect: {
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
    },
    metadata: {},
    registeredAt: new Date('2026-09-01T00:00:00Z'),
    importedAt: new Date('2026-09-01T00:00:00Z'),
    piiPseudonymisedAt: null,
    ...overrides,
  };
}

const FAKE_TX = {} as unknown;

describe('eventRegistrationLookupAdapter.findById — aggregate → view mapping', () => {
  it('maps a non-member aggregate to the primitive view (brands dropped)', async () => {
    findByIdMock.mockResolvedValueOnce({ ok: true, value: aggregate() });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({
      registrationId: 'reg-uuid-1',
      eventId: 'event-uuid-1',
      attendeeName: 'Guest Name',
      attendeeEmail: 'guest@example.com',
      attendeeCompany: 'Guest Co',
      ticketPriceThb: 2500,
      paymentStatus: 'paid',
      matchType: 'non_member',
      matchedMemberId: null,
      pseudonymised: false,
    });
  });

  it('maps a member-matched aggregate: matchedMemberId is un-branded to string', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: true,
      value: aggregate({
        match: {
          type: 'member_domain',
          matchedMemberId: 'member-uuid-9',
          matchedContactId: null,
        },
      }),
    });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value?.matchType).toBe('member_domain');
    expect(result.value?.matchedMemberId).toBe('member-uuid-9');
  });

  it('sets pseudonymised=true when piiPseudonymisedAt is non-null', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: true,
      value: aggregate({ piiPseudonymisedAt: new Date('2026-10-01T00:00:00Z') }),
    });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value?.pseudonymised).toBe(true);
  });

  it('passes through null ticketPriceThb / company (free or unknown ticket)', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: true,
      value: aggregate({
        attendee: { email: 'x@example.com', name: 'X', company: null },
        ticket: { type: null, priceThb: null, paymentStatus: 'unpaid' },
      }),
    });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value?.ticketPriceThb).toBeNull();
    expect(result.value?.attendeeCompany).toBeNull();
    expect(result.value?.paymentStatus).toBe('unpaid');
  });

  it('returns ok(null) when the F6 repo reports no row (miss / RLS-filtered)', async () => {
    findByIdMock.mockResolvedValueOnce({ ok: true, value: null });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-missing',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBeNull();
  });

  it('translates the F6 repo err branch to err({ kind: lookup_failed })', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', detail: 'connection refused' },
    });

    const result = await eventRegistrationLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'reg-uuid-1',
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error).toEqual({ kind: 'lookup_failed' });
  });
});
