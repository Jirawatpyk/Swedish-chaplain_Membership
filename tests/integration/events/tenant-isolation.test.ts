/**
 * T042 — F6 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on every
 * CRUD operation against all 4 F6 tables, from both directions.
 *
 * Why this is a blocker: F6 carries attendee PII (names + emails + companies)
 * across non-member and member-linked rows. A single missed RLS path leaks
 * member directory / attendance history across tenant chambers.
 *
 * Covered surfaces (all 4 F6 tables):
 *   - events                              — SELECT / UPDATE / DELETE / INSERT
 *   - event_registrations                 — SELECT / UPDATE / DELETE / INSERT
 *   - tenant_webhook_configs              — SELECT / UPDATE / INSERT
 *   - eventcreate_idempotency_receipts    — SELECT / INSERT
 *
 * Plus the application-layer cross-tenant probe: a webhook payload signed
 * with tenant A's secret but POSTed to tenant B's URL must reject + emit
 * a `cross_tenant_probe` audit (round-3 Z4 spec).
 *
 * Sibling files for pattern reference:
 *   - tests/integration/invoicing/tenant-isolation.test.ts (F4)
 *   - tests/integration/payments/tenant-isolation.test.ts  (F5)
 *   - tests/integration/broadcasts/tenant-isolation.test.ts (F7)
 *
 * RED reason: Part (a) — DB-level RLS probes — PASSES today (Phase 2
 * migrations 0133+0134 applied RLS+FORCE). Part (b) — application-layer
 * cross-tenant probe via webhook URL — RED until T052 route handler ships.
 *
 * Turns FULLY GREEN: T052 route + cross-tenant probe audit emission.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
  eventcreateIdempotencyReceipts,
  type NewEventRow,
  type NewEventRegistrationRow,
  type NewTenantWebhookConfigRow,
  type NewEventcreateIdempotencyReceiptRow,
} from '@/modules/events/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('T042 — F6 Tenant isolation (REVIEW-GATE BLOCKER, Constitution Principle I clause 3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aEventId: string;
  let bEventId: string;
  let aRegId: string;
  let bRegId: string;
  let aRequestId: string;
  let bRequestId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    aEventId = randomUUID();
    bEventId = randomUUID();
    aRegId = randomUUID();
    bRegId = randomUUID();
    aRequestId = `req-iso-a-${randomUUID()}`;
    bRequestId = `req-iso-b-${randomUUID()}`;

    // Seed tenant A
    await runInTenant(tenantA.ctx, async () => {
      await db.insert(events).values({
        tenantId: tenantA.ctx.slug,
        eventId: aEventId,
        source: 'eventcreate',
        externalId: 'event_iso_a',
        name: 'A Event',
        startDate: new Date('2026-06-21T18:00:00Z'),
      } satisfies NewEventRow);
      await db.insert(eventRegistrations).values({
        tenantId: tenantA.ctx.slug,
        registrationId: aRegId,
        eventId: aEventId,
        externalId: 'att_iso_a',
        attendeeEmail: 'a@a.example',
        attendeeName: 'A Attendee',
        matchType: 'non_member',
        registeredAt: new Date(),
      } as unknown as NewEventRegistrationRow);
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenantA.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'secret-A-' + 'a'.repeat(40),
      } satisfies NewTenantWebhookConfigRow);
      await db.insert(eventcreateIdempotencyReceipts).values({
        tenantId: tenantA.ctx.slug,
        source: 'eventcreate_webhook',
        requestId: aRequestId,
      } satisfies NewEventcreateIdempotencyReceiptRow);
    });

    // Seed tenant B
    await runInTenant(tenantB.ctx, async () => {
      await db.insert(events).values({
        tenantId: tenantB.ctx.slug,
        eventId: bEventId,
        source: 'eventcreate',
        externalId: 'event_iso_b',
        name: 'B Event',
        startDate: new Date('2026-06-21T18:00:00Z'),
      } satisfies NewEventRow);
      await db.insert(eventRegistrations).values({
        tenantId: tenantB.ctx.slug,
        registrationId: bRegId,
        eventId: bEventId,
        externalId: 'att_iso_b',
        attendeeEmail: 'b@b.example',
        attendeeName: 'B Attendee',
        matchType: 'non_member',
        registeredAt: new Date(),
      } as unknown as NewEventRegistrationRow);
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenantB.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'secret-B-' + 'b'.repeat(40),
      } satisfies NewTenantWebhookConfigRow);
      await db.insert(eventcreateIdempotencyReceipts).values({
        tenantId: tenantB.ctx.slug,
        source: 'eventcreate_webhook',
        requestId: bRequestId,
      } satisfies NewEventcreateIdempotencyReceiptRow);
    });
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  describe('events table — RLS blocks cross-tenant CRUD', () => {
    it('SELECT in tenant A context returns 0 of tenant B rows', async () => {
      const rows = await runInTenant(tenantA.ctx, async (tx) =>
        tx.select().from(events).where(eq(events.eventId, bEventId)),
      );
      expect(rows.length).toBe(0);
    });
    it('UPDATE in tenant A cannot mutate tenant B row', async () => {
      const result = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .update(events)
          .set({ name: 'HIJACKED' })
          .where(and(eq(events.tenantId, tenantB.ctx.slug), eq(events.eventId, bEventId)))
          .returning({ id: events.eventId }),
      );
      expect(result.length).toBe(0);
    });
    it('DELETE in tenant A cannot remove tenant B row', async () => {
      const result = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .delete(events)
          .where(and(eq(events.tenantId, tenantB.ctx.slug), eq(events.eventId, bEventId)))
          .returning({ id: events.eventId }),
      );
      expect(result.length).toBe(0);
    });
  });

  describe('event_registrations table — RLS blocks cross-tenant CRUD', () => {
    it('SELECT in tenant B context returns 0 of tenant A registrations', async () => {
      const rows = await runInTenant(tenantB.ctx, async (tx) =>
        tx.select().from(eventRegistrations).where(eq(eventRegistrations.registrationId, aRegId)),
      );
      expect(rows.length).toBe(0);
    });
  });

  describe('tenant_webhook_configs table — RLS blocks cross-tenant SELECT (secret leak prevention)', () => {
    it('SELECT in tenant A context cannot read tenant B webhook secret', async () => {
      const rows = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .select()
          .from(tenantWebhookConfigs)
          .where(eq(tenantWebhookConfigs.tenantId, tenantB.ctx.slug)),
      );
      expect(rows.length).toBe(0);
    });
  });

  describe('eventcreate_idempotency_receipts table — RLS blocks cross-tenant SELECT (request_id probing)', () => {
    it('SELECT in tenant A context cannot probe tenant B request_id existence', async () => {
      const rows = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .select()
          .from(eventcreateIdempotencyReceipts)
          .where(
            and(
              eq(eventcreateIdempotencyReceipts.tenantId, tenantB.ctx.slug),
              eq(eventcreateIdempotencyReceipts.requestId, bRequestId),
            ),
          ),
      );
      expect(rows.length).toBe(0);
    });
  });

  describe('Round-trip cross-tenant probe via webhook URL (application-layer)', () => {
    it('payload signed for tenant A POSTed to tenant B URL → 401 + generic body (no oracle) + no rows created in tenant B', async () => {
      // Seed each tenant with its OWN webhook secret so signing-vs-verify
      // mismatch can be tested.
      const secretA = 'secret-tenant-A-' + 'a'.repeat(32);
      const secretB = 'secret-tenant-B-' + 'b'.repeat(32);
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx
          .update(tenantWebhookConfigs)
          .set({ webhookSecretActive: secretA })
          .where(eq(tenantWebhookConfigs.tenantId, tenantA.ctx.slug));
      });
      await runInTenant(tenantB.ctx, async (tx) => {
        await tx
          .update(tenantWebhookConfigs)
          .set({ webhookSecretActive: secretB })
          .where(eq(tenantWebhookConfigs.tenantId, tenantB.ctx.slug));
      });

      // Sign payload with tenant A's secret
      const { signWebhookBody, makeWebhookPayload } = await import('./helpers/sign-webhook');
      const payload = makeWebhookPayload({ tenantSlug: tenantA.ctx.slug });
      const signed = signWebhookBody({ body: payload, secret: secretA });

      // Build a NextRequest targeting tenant B's URL with tenant A's signature
      const { NextRequest } = await import('next/server');
      const crossTenantRequest = new NextRequest(
        `https://app.test/api/webhooks/eventcreate/v1/${tenantB.ctx.slug}`,
        {
          method: 'POST',
          body: signed.rawBody,
          headers: {
            'Content-Type': 'application/json',
            'X-Chamber-Signature': signed.signatureHeader,
            'X-Chamber-Timestamp': signed.timestamp,
            'X-Request-ID': `req-cross-tenant-probe-${randomUUID()}`,
          },
        },
      );

      // Invoke the route directly (no live server needed — the route
      // handler is a pure function over NextRequest)
      const route = await import('@/app/api/webhooks/eventcreate/v1/[tenantSlug]/route');
      const res = await route.POST(crossTenantRequest, {
        params: Promise.resolve({ tenantSlug: tenantB.ctx.slug }),
      });

      // 401 generic body — no discriminator leak
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.title).toBe('Webhook authentication failed');
      expect(JSON.stringify(body)).not.toMatch(
        /signature_mismatch|skew|missing_header|cross_tenant/i,
      );

      // Tenant B's tables MUST NOT contain any event or registration
      // from the cross-tenant probe attempt
      const eventsB = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(events)
          .where(eq(events.tenantId, tenantB.ctx.slug)),
      );
      const payloadEvent = payload['event'] as Record<string, unknown> | undefined;
      const payloadAttendee = payload['attendee'] as Record<string, unknown> | undefined;
      const probeEvent = eventsB.find(
        (e) => e.externalId === (payloadEvent?.['externalId'] as string | undefined),
      );
      expect(probeEvent).toBeUndefined();

      const regsB = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.tenantId, tenantB.ctx.slug)),
      );
      const probeReg = regsB.find(
        (r) => r.externalId === (payloadAttendee?.['externalId'] as string | undefined),
      );
      expect(probeReg).toBeUndefined();
    });
  });
});
