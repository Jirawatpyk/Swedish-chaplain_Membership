/**
 * R2-6 (2026-05-18 /speckit-review Round 2) — Principle I (tenant
 * isolation) Review-Gate probe for the F6.1 events list search filter.
 *
 * The existing `list-events-search.test.ts` validates the search rule
 * within ONE tenant; this suite verifies that the rule does NOT leak
 * across tenant boundaries. Per Constitution v1.4.0 Principle I sub-
 * clause "every new tenant-scoped read surface needs a cross-tenant
 * probe", any predicate that joins `tenant_id` + a user-controlled
 * filter is a probe candidate.
 *
 * Threat: an attacker who controls the `q` URL parameter could try
 * to substring-match into another tenant's event names via the same
 * `ilike(events.name, '%…%')` clause. Postgres RLS (FORCE) and the
 * tenant_id WHERE clause in `drizzle-events-repository.list()` should
 * BOTH block this — RLS at the row-visibility layer, the WHERE at
 * the query plan layer (defence in depth).
 *
 * Live DB cost: ~4-6s wall-clock (2 tenants × 1 seeded event + 1 probe).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { events } from '@/modules/events/infrastructure/schema';
import { runListEvents } from '@/lib/events-admin-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F6.1 listEvents searchQuery cross-tenant probe (Principle I — live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    // Tenant A seeds an event with a highly-distinctive name. The
    // substring "Confidential-A" cannot occur in any organic event
    // name — if tenant B sees it, RLS was bypassed.
    await db.insert(events).values({
      tenantId: tenantA.ctx.slug,
      eventId: randomUUID(),
      source: 'eventcreate',
      externalId: `event_xtenant_a_${randomUUID().slice(0, 8)}`,
      name: 'Confidential-A Tenant-Only Event',
      startDate: new Date('2026-07-10T13:00:00Z'),
      isPartnerBenefit: false,
      isCulturalEvent: false,
    } as unknown as typeof events.$inferInsert);

    // Tenant B has its own unrelated event so the test isn't running
    // against an empty tenant (which could mask "search returns
    // nothing because nothing exists" as a false-positive isolation).
    await db.insert(events).values({
      tenantId: tenantB.ctx.slug,
      eventId: randomUUID(),
      source: 'eventcreate',
      externalId: `event_xtenant_b_${randomUUID().slice(0, 8)}`,
      name: 'Tenant B Annual Meeting',
      startDate: new Date('2026-07-12T13:00:00Z'),
      isPartnerBenefit: false,
      isCulturalEvent: false,
    } as unknown as typeof events.$inferInsert);
  });

  afterAll(async () => {
    await tenantA?.cleanup();
    await tenantB?.cleanup();
  });

  it("tenant B's search for 'Confidential-A' returns zero rows (RLS blocks tenant A's event)", async () => {
    const r = await runListEvents(tenantB.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'Confidential-A',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Strict zero — Tenant B has zero events with this substring.
    // Tenant A has one, which would surface here IF RLS were bypassed.
    expect(r.value.items).toHaveLength(0);
    expect(r.value.pagination.totalCount).toBe(0);
  });

  it("tenant A's same search returns its own event (control — verifies the substring is matchable)", async () => {
    // Control assertion: if this fails, the test setup is broken (the
    // event isn't in the DB) and the prior assertion isn't actually
    // proving cross-tenant isolation.
    const r = await runListEvents(tenantA.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: 'Confidential-A',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]?.name).toBe('Confidential-A Tenant-Only Event');
  });

  it("tenant B's unfiltered list does NOT include tenant A's event", async () => {
    // Belt-and-braces: even without the search filter, tenant B's
    // overall list should only show its own row. This catches a
    // narrower class of bug (search filter passing tenant_id but
    // base list query somehow leaking).
    const r = await runListEvents(tenantB.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.items.map((i) => i.name);
    expect(names).toContain('Tenant B Annual Meeting');
    expect(names).not.toContain('Confidential-A Tenant-Only Event');
  });

  it("SQL-injection-shaped search returns zero rows (Drizzle ilike parameterises correctly)", async () => {
    // R2-6 sanity: a hand-typed adversarial `q=` should reach the
    // repo as a literal substring (Drizzle binds it via $1) and not
    // alter the query plan. We assert zero rows return (the literal
    // doesn't appear in any seeded name) AND that the call resolves
    // ok (no SQL syntax error bubbling up as a 500).
    const r = await runListEvents(tenantB.ctx.slug, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
      searchQuery: "'%' OR 1=1 --",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(0);
  });
});
