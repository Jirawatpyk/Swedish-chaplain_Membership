/**
 * F6.1 follow-up 2026-05-18 — `loadEventDetail.paymentStatusFilter`.
 *
 * Backs the AttendeeTable Select chip. Repo applies
 * `eq(eventRegistrations.paymentStatus, input.paymentStatusFilter)`
 * when non-null. This test pins:
 *   1. `null` returns all rows.
 *   2. `'pending'` returns only the pending row.
 *   3. `'waitlisted'` returns only the waitlisted row.
 *
 * Live DB cost: ~3-5s wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F6.1 loadEventDetail.paymentStatusFilter (live Neon)', () => {
  let tenant: TestTenant;
  let eventId: string;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    eventId = randomUUID();
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `event_pmt_filter_${randomUUID().slice(0, 8)}`,
      name: 'Payment status filter test',
      startDate: new Date('2026-06-21T18:00:00Z'),
      isPartnerBenefit: false,
      isCulturalEvent: false,
    } as unknown as NewEventRow);

    const statuses = ['paid', 'pending', 'waitlisted', 'no_show'] as const;
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i]!;
      await db.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: randomUUID(),
        eventId,
        externalId: `att_${s}_${randomUUID().slice(0, 8)}`,
        attendeeEmail: `${s}@filter.test`,
        attendeeName: `${s} Attendee`,
        matchType: 'non_member',
        paymentStatus: s,
        registeredAt: new Date(),
      } as unknown as NewEventRegistrationRow);
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('paymentStatusFilter=null returns all rows', async () => {
    const r = await runLoadEventDetail(tenant.ctx.slug, {
      eventId,
      page: 1,
      pageSize: 50,
      unmatchedOnly: false,
      matchTypeFilter: null,
      q: null,
      paymentStatusFilter: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.registrations).toHaveLength(4);
  });

  it('paymentStatusFilter=pending returns only pending row', async () => {
    const r = await runLoadEventDetail(tenant.ctx.slug, {
      eventId,
      page: 1,
      pageSize: 50,
      unmatchedOnly: false,
      matchTypeFilter: null,
      q: null,
      paymentStatusFilter: 'pending',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.registrations).toHaveLength(1);
    expect(r.value.registrations[0]?.paymentStatus).toBe('pending');
  });

  it('paymentStatusFilter=waitlisted returns only waitlisted row', async () => {
    const r = await runLoadEventDetail(tenant.ctx.slug, {
      eventId,
      page: 1,
      pageSize: 50,
      unmatchedOnly: false,
      matchTypeFilter: null,
      q: null,
      paymentStatusFilter: 'waitlisted',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.registrations).toHaveLength(1);
    expect(r.value.registrations[0]?.paymentStatus).toBe('waitlisted');
  });
});
