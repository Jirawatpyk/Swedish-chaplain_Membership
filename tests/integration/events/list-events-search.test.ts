/**
 * F6.1 follow-up 2026-05-18 — events list `searchQuery` filter.
 *
 * Backs the `<EventsListSearchToolbar>` URL-driven server filter.
 * Repo applies `ilike(events.name, '%trimmed%')`; this test pins:
 *   1. Substring match (single hit).
 *   2. Case-insensitive (uppercase query matches title-case row).
 *   3. Whitespace-only treated as no filter (returns all).
 *   4. Combined with `partnerBenefitOnly` filter (intersection).
 *
 * Live DB cost: ~3-5s wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { events } from '@/modules/events/infrastructure/schema';
import { runListEvents } from '@/lib/events-admin-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F6.1 listEvents searchQuery (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    // Three events with distinct names so the test asserts which one
    // ilike matches. Names are intentionally varied so substring
    // matches are deterministic per assertion.
    await db.insert(events).values([
      {
        tenantId: tenant.ctx.slug,
        eventId: randomUUID(),
        source: 'eventcreate',
        externalId: `event_search_${randomUUID().slice(0, 8)}`,
        name: 'Q1 Workshop',
        startDate: new Date('2026-01-15T13:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      },
      {
        tenantId: tenant.ctx.slug,
        eventId: randomUUID(),
        source: 'eventcreate',
        externalId: `event_search_${randomUUID().slice(0, 8)}`,
        name: 'Annual General Meeting',
        startDate: new Date('2026-03-20T13:00:00Z'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      },
      {
        tenantId: tenant.ctx.slug,
        eventId: randomUUID(),
        source: 'eventcreate',
        externalId: `event_search_${randomUUID().slice(0, 8)}`,
        name: 'Cultural Mixer',
        startDate: new Date('2026-04-10T13:00:00Z'),
        isPartnerBenefit: true,
        isCulturalEvent: true,
      },
    ] as unknown as typeof events.$inferInsert[]);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('substring search returns only matching rows', async () => {
    const r = await runListEvents(tenant.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'meet',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]?.name).toBe('Annual General Meeting');
    expect(r.value.pagination.totalCount).toBe(1);
  });

  it('search is case-insensitive', async () => {
    const r = await runListEvents(tenant.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'WORK',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]?.name).toBe('Q1 Workshop');
  });

  it('whitespace-only searchQuery is treated as no filter', async () => {
    const r = await runListEvents(tenant.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: '   ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(3);
  });

  it('searchQuery combines with partnerBenefitOnly (intersection)', async () => {
    // "meet" matches only AGM, but AGM is not partner-benefit.
    const r = await runListEvents(tenant.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: true,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'meet',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(0);

    // "mix" only matches Cultural Mixer, which IS partner-benefit.
    const r2 = await runListEvents(tenant.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: true,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'mix',
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.items).toHaveLength(1);
    expect(r2.value.items[0]?.name).toBe('Cultural Mixer');
  });
});
