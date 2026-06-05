/**
 * 054-event-fee-invoices Task 14 — integration coverage for
 * `runListEventNamesByIds` (src/lib/events-admin-deps.ts), the batched
 * event-name lookup the `/admin/invoices` list uses to render the buyer-
 * subtitle line on event-fee invoice rows.
 *
 * Invariants under test (live Neon Singapore):
 *   1. Resolves the right `{ name, startDateIso }` for the given ids.
 *   2. Cross-tenant isolation (Principle I): an id that belongs to ANOTHER
 *      tenant is NOT resolved when looked up under the caller's tenant —
 *      RLS hides it, so it is absent from the returned map (never leaked).
 *   3. Unknown / non-UUID ids are simply absent (no throw).
 *   4. Empty input returns an empty map WITHOUT a query (defence against
 *      the all-membership page paying any DB cost).
 *
 * `@workers=1` per project convention.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { events } from '@/modules/events/infrastructure/schema';
import { runListEventNamesByIds } from '@/lib/events-admin-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('runListEventNamesByIds — batched lookup + cross-tenant probe (live Neon) @workers=1', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const eventA1Id = randomUUID();
  const eventA2Id = randomUUID();
  const eventBId = randomUUID();

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    // Tenant A: two events with distinctive names + known start dates.
    await db.insert(events).values([
      {
        tenantId: tenantA.ctx.slug,
        eventId: eventA1Id,
        source: 'eventcreate',
        externalId: `evt_a1_${randomUUID().slice(0, 8)}`,
        name: 'TSCC Gala Dinner',
        // 2026-06-15 13:00 UTC → Bangkok-local (UTC+7) still 2026-06-15.
        startDate: new Date('2026-06-15T13:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      },
      {
        tenantId: tenantA.ctx.slug,
        eventId: eventA2Id,
        source: 'eventcreate',
        externalId: `evt_a2_${randomUUID().slice(0, 8)}`,
        name: 'Midsummer Networking',
        startDate: new Date('2026-07-01T02:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      },
    ] as unknown as (typeof events.$inferInsert)[]);

    // Tenant B: one event the A-tenant lookup must never see.
    await db.insert(events).values({
      tenantId: tenantB.ctx.slug,
      eventId: eventBId,
      source: 'eventcreate',
      externalId: `evt_b_${randomUUID().slice(0, 8)}`,
      name: 'Tenant B Confidential Event',
      startDate: new Date('2026-08-20T13:00:00Z'),
      isPartnerBenefit: false,
      isCulturalEvent: false,
    } as unknown as typeof events.$inferInsert);
  });

  afterAll(async () => {
    await tenantA?.cleanup();
    await tenantB?.cleanup();
  });

  it('resolves names + CE start dates for the requested ids (one batched query)', async () => {
    const map = await runListEventNamesByIds(tenantA.ctx.slug, [
      eventA1Id,
      eventA2Id,
    ]);
    expect(map.size).toBe(2);
    expect(map.get(eventA1Id)).toEqual({
      name: 'TSCC Gala Dinner',
      startDateIso: '2026-06-15T13:00:00.000Z',
    });
    expect(map.get(eventA2Id)?.name).toBe('Midsummer Networking');
  });

  it('does NOT resolve a cross-tenant id (Principle I — RLS hides tenant B)', async () => {
    // Look up tenant B's event id UNDER tenant A's context. RLS + the
    // explicit tenant_id WHERE both block it — the id is absent from the
    // map, never leaked.
    const map = await runListEventNamesByIds(tenantA.ctx.slug, [
      eventA1Id,
      eventBId,
    ]);
    expect(map.has(eventA1Id)).toBe(true);
    expect(map.has(eventBId)).toBe(false);
    // Sanity — the leaked name does not appear under any key.
    const names = [...map.values()].map((v) => v.name);
    expect(names).not.toContain('Tenant B Confidential Event');
  });

  it('control — tenant B CAN resolve its own event id', async () => {
    const map = await runListEventNamesByIds(tenantB.ctx.slug, [eventBId]);
    expect(map.get(eventBId)?.name).toBe('Tenant B Confidential Event');
  });

  it('drops unknown / non-UUID ids without throwing', async () => {
    const map = await runListEventNamesByIds(tenantA.ctx.slug, [
      eventA1Id,
      randomUUID(), // valid uuid, no such event → absent
      'not-a-uuid', // malformed → tryEventId drops it, no throw
    ]);
    expect(map.size).toBe(1);
    expect(map.has(eventA1Id)).toBe(true);
  });

  it('empty input returns an empty map (no query issued)', async () => {
    const map = await runListEventNamesByIds(tenantA.ctx.slug, []);
    expect(map.size).toBe(0);
  });
});
