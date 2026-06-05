/**
 * 054-event-fee-invoices Task 14 — unit coverage for the Drizzle events
 * repository `findByIds` batch lookup.
 *
 * The integration test (`tests/integration/events/list-event-names-by-ids.test.ts`)
 * proves correctness + cross-tenant isolation against live Neon. This unit
 * test pins the two structural invariants that an integration test cannot
 * cheaply observe:
 *
 *   1. N ids → exactly ONE `.select()` chain (no N+1). A future refactor
 *      that loops `findById` per id would fail this.
 *   2. Empty `eventIds` → ZERO executor calls (the all-membership invoice
 *      page pays no DB cost). This is the guard `runListEventNamesByIds`
 *      and the page-level "only call when there are event rows" check both
 *      lean on.
 *
 * Strategy: inject a fake `TenantTx` whose `.select().from().where()` chain
 * resolves to a fixed row array, and count how many times `.select()` is
 * invoked.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { asTenantId } from '@/modules/members';
import { asEventId } from '@/modules/events';
import type { TenantTx } from '@/lib/db';

const TENANT = asTenantId('test-tenant');
const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

function makeRow(eventId: string, name: string) {
  return {
    tenantId: 'test-tenant',
    eventId,
    source: 'eventcreate',
    externalId: `ext_${eventId.slice(0, 8)}`,
    name,
    description: null,
    startDate: new Date('2026-06-15T13:00:00Z'),
    endDate: null,
    location: null,
    category: null,
    eventcreateUrl: null,
    isPartnerBenefit: false,
    isCulturalEvent: false,
    archivedAt: null,
    metadata: null,
    importedAt: new Date('2026-06-01T00:00:00Z'),
    lastUpdatedAt: new Date('2026-06-01T00:00:00Z'),
  };
}

/**
 * Fake executor — `.select()` increments a counter and returns a thenable
 * chain (`.from().where()`) resolving to `rows`.
 */
function makeFakeExecutor(rows: ReturnType<typeof makeRow>[]) {
  const selectSpy = vi.fn();
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  const executor = {
    select: () => {
      selectSpy();
      return chain;
    },
  } as unknown as TenantTx;
  return { executor, selectSpy };
}

describe('drizzle events repository — findByIds (Task 14 batch lookup)', () => {
  it('issues exactly ONE select for N ids (no N+1) and keys the map by eventId', async () => {
    const { executor, selectSpy } = makeFakeExecutor([
      makeRow(ID_1, 'TSCC Gala Dinner'),
      makeRow(ID_2, 'Midsummer Networking'),
    ]);
    const repo = makeDrizzleEventsRepository(executor);

    const result = await repo.findByIds(TENANT, [asEventId(ID_1), asEventId(ID_2)]);

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(2);
    expect(result.value.get(asEventId(ID_1))?.name).toBe('TSCC Gala Dinner');
    expect(result.value.get(asEventId(ID_2))?.name).toBe('Midsummer Networking');
  });

  it('short-circuits empty input — ZERO executor calls, empty map', async () => {
    const { executor, selectSpy } = makeFakeExecutor([]);
    const repo = makeDrizzleEventsRepository(executor);

    const result = await repo.findByIds(TENANT, []);

    expect(selectSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(0);
  });
});
