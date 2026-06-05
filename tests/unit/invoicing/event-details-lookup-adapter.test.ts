/**
 * Task 6a (054-event-fee-invoices) — unit test for the invoicing
 * event-details-lookup adapter's aggregate → view mapping.
 *
 * The live-Neon cross-tenant test
 * (tests/integration/invoicing/event-details-lookup-cross-tenant.test.ts)
 * proves the RLS data-isolation property. This unit test pins the pure
 * branded → primitive mapping (eventId, name, startDate → startDateIso via
 * Date.toISOString()) + the ok(null) passthrough + the err-branch
 * translation, with the F6 barrel lookup mocked so we drive exact
 * aggregates without a DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByIdMock = vi.fn();

vi.mock('@/modules/events', () => ({
  asTenantId: (s: string) => s,
  asEventId: (s: string) => s,
  makeEventDetailsLookupForTenant: () => ({ findById: findByIdMock }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { eventDetailsLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-details-lookup-adapter';
import { logger } from '@/lib/logger';

// Minimal hand-built aggregate shaped like an F6 EventAggregate. Branded
// fields are plain strings at runtime; the cast satisfies the adapter's
// `String(...)` un-branding path.
function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    eventId: 'event-uuid-1',
    source: 'eventcreate',
    externalId: 'evt_ext_1',
    name: 'Annual Gala',
    description: null,
    startDate: new Date('2026-09-10T11:00:00.000Z'),
    endDate: null,
    location: null,
    category: null,
    eventcreateUrl: null,
    isPartnerBenefit: false,
    isCulturalEvent: false,
    archivedAt: null,
    metadata: {},
    importedAt: new Date('2026-09-01T00:00:00Z'),
    lastUpdatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const FAKE_TX = {} as unknown;

describe('eventDetailsLookupAdapter.findById — aggregate → view mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps an event aggregate to the primitive view (brand dropped, startDate → ISO)', async () => {
    findByIdMock.mockResolvedValueOnce({ ok: true, value: aggregate() });

    const result = await eventDetailsLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'event-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toEqual({
      eventId: 'event-uuid-1',
      name: 'Annual Gala',
      startDateIso: '2026-09-10T11:00:00.000Z',
    });
  });

  it('serialises startDate via Date.toISOString() (CE/UTC — BE is display-only)', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: true,
      value: aggregate({ startDate: new Date('2027-01-31T17:30:00.000Z') }),
    });

    const result = await eventDetailsLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'event-uuid-1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value?.startDateIso).toBe('2027-01-31T17:30:00.000Z');
  });

  it('returns ok(null) when the F6 repo reports no row (miss / RLS-filtered)', async () => {
    findByIdMock.mockResolvedValueOnce({ ok: true, value: null });

    const result = await eventDetailsLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'event-uuid-missing',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBeNull();
  });

  it('translates the F6 repo err branch to err({ kind: lookup_failed }) and emits a structured pino breadcrumb', async () => {
    findByIdMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', message: 'connection refused' },
    });

    const result = await eventDetailsLookupAdapter.findById(
      FAKE_TX,
      'test-tenant',
      'event-uuid-err',
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error).toEqual({ kind: 'lookup_failed' });

    // Pin the logging contract: a structured breadcrumb MUST be emitted so
    // the F6 repo error is observable in production logs. A future refactor
    // that silently drops logger.error would now be caught here.
    expect(vi.mocked(logger.error)).toHaveBeenCalledOnce();
    const [bindings] = vi.mocked(logger.error).mock.calls[0]!;
    expect((bindings as Record<string, unknown>)['event']).toBe(
      'f4_event_details_lookup_failed',
    );
    expect((bindings as Record<string, unknown>)['tenantId']).toBe('test-tenant');
    // eventId in the breadcrumb — no PII
    expect((bindings as Record<string, unknown>)['eventId']).toBe('event-uuid-err');
  });
});
