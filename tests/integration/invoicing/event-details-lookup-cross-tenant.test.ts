/**
 * Task 6a (054-event-fee-invoices) — EventDetailsLookupPort cross-tenant
 * isolation integration test (Constitution v1.4.0 Principle I — REVIEW-GATE
 * BLOCKER).
 *
 * The F4 invoicing module reads F6 event details (name + start date) through
 * the `EventDetailsLookupPort` adapter so a chamber's event-fee invoice line
 * description can name the event. The read MUST run under the caller's
 * `runInTenant` tx (which holds `SET LOCAL app.current_tenant`) so Postgres
 * RLS filters out any cross-tenant row. This test proves three properties:
 *
 *   1. In-tenant happy path — adapter.findById(tx, tenantA, eventA) returns
 *      the mapped view with name + startDateIso + eventId.
 *   2. Cross-tenant isolation — adapter.findById(tx, tenantB, eventA) returns
 *      ok(null): RLS hides tenant A's row from tenant B's context, NO data
 *      leaks. THIS is the Principle-I blocker assertion.
 *   3. Genuine miss — adapter.findById(tx, tenantA, <random uuid>) → ok(null).
 *
 * Sibling pattern reference (Task 5):
 *   - tests/integration/invoicing/event-registration-lookup-cross-tenant.test.ts
 *   - tests/integration/events/tenant-isolation.test.ts (F6 seed pattern)
 *
 * Lives in tests/integration/** → hits live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { events, type NewEventRow } from '@/modules/events/infrastructure/schema';
import { eventDetailsLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-details-lookup-adapter';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('EventDetailsLookupPort — cross-tenant isolation (Principle I — REVIEW-GATE BLOCKER)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aEventId: string;
  const startIso = '2026-09-10T11:00:00.000Z';

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    aEventId = randomUUID();

    // Seed one event in tenant A only.
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenantA.ctx.slug,
        eventId: aEventId,
        source: 'eventcreate',
        externalId: 'evt_details_iso_a',
        name: 'Annual Gala (tenant A)',
        startDate: new Date(startIso),
      } satisfies NewEventRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('in-tenant happy path: A reads its own event → ok(view) with name + startDateIso + eventId', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      eventDetailsLookupAdapter.findById(tx, tenantA.ctx.slug, aEventId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const view = result.value;
    expect(view).not.toBeNull();
    if (view === null) throw new Error('expected non-null view');

    expect(view.eventId).toBe(aEventId);
    expect(view.name).toBe('Annual Gala (tenant A)');
    // startDate stored CE/UTC; mapped via Date.toISOString() — BE is
    // display-only so storage + this view stay Gregorian.
    expect(view.startDateIso).toBe(startIso);
  });

  it('cross-tenant isolation: B cannot read A event → ok(null), NO tenant-A data leaks (Principle-I blocker)', async () => {
    const result = await runInTenant(tenantB.ctx, (tx) =>
      eventDetailsLookupAdapter.findById(tx, tenantB.ctx.slug, aEventId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // RLS scoped the read to tenant B → tenant A's row is invisible.
    expect(result.value).toBeNull();
  });

  it('genuine miss: A queries a random non-existent event id → ok(null)', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      eventDetailsLookupAdapter.findById(tx, tenantA.ctx.slug, randomUUID()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBeNull();
  });
});
