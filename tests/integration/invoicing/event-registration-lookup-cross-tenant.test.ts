/**
 * Task 5 (054-event-fee-invoices) — EventRegistrationLookupPort cross-tenant
 * isolation integration test (Constitution v1.4.0 Principle I — REVIEW-GATE
 * BLOCKER).
 *
 * The F4 invoicing module reads F6 event registrations through the
 * `EventRegistrationLookupPort` adapter so a chamber's event-fee invoice can
 * snapshot attendee + ticket data. The read MUST run under the caller's
 * `runInTenant` tx (which holds `SET LOCAL app.current_tenant`) so Postgres
 * RLS filters out any cross-tenant row. This test proves three properties:
 *
 *   1. In-tenant happy path — adapter.findById(tx, tenantA, regA) returns the
 *      mapped view with the seeded ticket / match / attendee fields.
 *   2. Cross-tenant isolation — adapter.findById(tx, tenantB, regA) returns
 *      ok(null): RLS hides tenant A's row from tenant B's context, NO data
 *      leaks. THIS is the Principle-I blocker assertion.
 *   3. Genuine miss — adapter.findById(tx, tenantA, <random uuid>) → ok(null).
 *
 * The `registration_cross_tenant_probe` AUDIT event is NOT emitted here — it
 * belongs to the `createEventInvoiceDraft` use-case (Task 6) where the audit
 * port lives. This test proves the RLS data-isolation property only.
 *
 * Sibling pattern reference:
 *   - tests/integration/invoicing/tenant-isolation.test.ts (F4 RLS matrix)
 *   - tests/integration/events/tenant-isolation.test.ts    (F6 seed pattern)
 *
 * Lives in tests/integration/** → hits live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('EventRegistrationLookupPort — cross-tenant isolation (Principle I — REVIEW-GATE BLOCKER)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aEventId: string;
  let aRegId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    aEventId = randomUUID();
    aRegId = randomUUID();

    // Seed one event + one non-member registration in tenant A only.
    // event_registrations carries a composite FK (tenant_id + event_id) to
    // events, so the event row must exist first.
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenantA.ctx.slug,
        eventId: aEventId,
        source: 'eventcreate',
        externalId: 'evt_fee_iso_a',
        name: 'Annual Gala (tenant A)',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenantA.ctx.slug,
        registrationId: aRegId,
        eventId: aEventId,
        externalId: 'att_fee_iso_a',
        attendeeEmail: 'gala.guest@alpha.example',
        attendeeName: 'Gala Guest',
        attendeeCompany: 'Alpha Trading Co',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 3500,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } as unknown as NewEventRegistrationRow);
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('in-tenant happy path: A reads its own registration → ok(view) with mapped fields', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      eventRegistrationLookupAdapter.findById(tx, tenantA.ctx.slug, aRegId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const view = result.value;
    expect(view).not.toBeNull();
    if (view === null) throw new Error('expected non-null view');

    expect(view.registrationId).toBe(aRegId);
    expect(view.eventId).toBe(aEventId);
    expect(view.attendeeName).toBe('Gala Guest');
    expect(view.attendeeEmail).toBe('gala.guest@alpha.example');
    expect(view.attendeeCompany).toBe('Alpha Trading Co');
    expect(view.ticketPriceThb).toBe(3500);
    expect(view.paymentStatus).toBe('paid');
    expect(view.matchType).toBe('non_member');
    expect(view.matchedMemberId).toBeNull();
    expect(view.pseudonymised).toBe(false);
  });

  it('cross-tenant isolation: B cannot read A registration → ok(null), NO tenant-A data leaks (Principle-I blocker)', async () => {
    const result = await runInTenant(tenantB.ctx, (tx) =>
      eventRegistrationLookupAdapter.findById(tx, tenantB.ctx.slug, aRegId),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // RLS scoped the read to tenant B → tenant A's row is invisible.
    expect(result.value).toBeNull();
  });

  it('genuine miss: A queries a random non-existent registration id → ok(null)', async () => {
    const result = await runInTenant(tenantA.ctx, (tx) =>
      eventRegistrationLookupAdapter.findById(tx, tenantA.ctx.slug, randomUUID()),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toBeNull();
  });
});
