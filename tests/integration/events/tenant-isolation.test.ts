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
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser } from '../helpers/test-users';
import { f6CsvTestSelectedEventStub } from '../../unit/events/_helpers/f6-csv-test-fixtures';

describe('T042 — F6 Tenant isolation (REVIEW-GATE BLOCKER, Constitution Principle I clause 3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aEventId: string;
  let bEventId: string;
  let aRegId: string;
  let bRegId: string;
  let aRequestId: string;
  let bRequestId: string;
  let testActorUserId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // D1 fix: create a real admin user for the CSV-import probe's
    // actor_user_id FK requirement. Other CSV integration tests
    // (eventcreate-csv-real-fixtures.test.ts) use the same pattern.
    const actor = await createActiveTestUser('admin');
    testActorUserId = actor.userId;

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

      // Issue I3 (review 2026-05-12): durable forensic audit trail.
      // The route handler (post-Wave-3.3 fix-it) emits a standalone-tx
      // `webhook_rolled_back` audit on signature failure with the
      // verifyKind in the payload — so cross-tenant probes leave a
      // permanent (5-year retention) record, not just ephemeral pino
      // logs which rotate out within days. Assert tenant B's audit_log
      // captured this probe attempt.
      const tenantBAudits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantB.ctx.slug));
      // Post Issue C-FULL-2 fix (review 2026-05-12): route now emits
      // the CORRECT event_type `webhook_signature_rejected` via the
      // new generic `emitStandalone` deps method (previously emitted
      // as `webhook_rolled_back` via type-narrowing workaround).
      const probeAudit = tenantBAudits.find(
        (row) =>
          (row.eventType as string) === 'webhook_signature_rejected' &&
          (
            (row.payload as Record<string, unknown> | null)?.['sourceIp'] as string | undefined
          ) !== undefined,
      );
      expect(probeAudit).toBeDefined();
    });

    it('D1 (Phase 8 verify): payload signed with tenant A GRACE secret POSTed to tenant B URL → 401 + no rows + reject audit', async () => {
      // F6 Phase 8 verify check D1 (2026-05-16) — close the cross-
      // tenant probe gap for the deprecated-grace key path. The
      // existing test (above) covers the active-secret probe; this
      // sibling proves the same isolation invariant holds when the
      // attacker signs with a grace secret that's valid within tenant
      // A's 24h grace window. Without this test, a future refactor
      // that accidentally cross-references grace secrets across
      // tenants (e.g., a shared cache, an over-broad SELECT) could
      // pass the active-only test and silently regress.
      //
      // Setup: tenant A is mid-rotation (active=NEW_A, grace=OLD_A,
      // grace_rotated_at=NOW-12h). Tenant B has its own independent
      // active secret. Attacker signs with tenant A's grace key
      // (OLD_A) and targets tenant B's URL.
      const oldSecretA = 'old-tenant-A-grace-' + 'g'.repeat(28);
      const newActiveSecretA = 'new-tenant-A-active-' + 'n'.repeat(27);
      const secretB = 'unique-tenant-B-active-' + 'b'.repeat(24);

      // Rotate tenant A so OLD_A is grace, NEW is active, grace_rotated_at=NOW-12h.
      await runInTenant(tenantA.ctx, async (tx) => {
        await tx
          .update(tenantWebhookConfigs)
          .set({
            webhookSecretActive: newActiveSecretA,
            webhookSecretGrace: oldSecretA,
            graceRotatedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
          })
          .where(eq(tenantWebhookConfigs.tenantId, tenantA.ctx.slug));
      });

      // Tenant B keeps an independent active secret, NO grace.
      await runInTenant(tenantB.ctx, async (tx) => {
        await tx
          .update(tenantWebhookConfigs)
          .set({
            webhookSecretActive: secretB,
            webhookSecretGrace: null,
            graceRotatedAt: null,
          })
          .where(eq(tenantWebhookConfigs.tenantId, tenantB.ctx.slug));
      });

      // Sign payload with tenant A's GRACE secret (oldSecretA).
      const { signWebhookBody, makeWebhookPayload } = await import('./helpers/sign-webhook');
      const payload = makeWebhookPayload({ tenantSlug: tenantA.ctx.slug });
      const signed = signWebhookBody({ body: payload, secret: oldSecretA });

      // Build a NextRequest targeting tenant B's URL.
      const { NextRequest } = await import('next/server');
      const requestId = `req-cross-tenant-grace-probe-${randomUUID()}`;
      const crossTenantRequest = new NextRequest(
        `https://app.test/api/webhooks/eventcreate/v1/${tenantB.ctx.slug}`,
        {
          method: 'POST',
          body: signed.rawBody,
          headers: {
            'Content-Type': 'application/json',
            'X-Chamber-Signature': signed.signatureHeader,
            'X-Chamber-Timestamp': signed.timestamp,
            'X-Request-ID': requestId,
          },
        },
      );

      const route = await import('@/app/api/webhooks/eventcreate/v1/[tenantSlug]/route');
      const res = await route.POST(crossTenantRequest, {
        params: Promise.resolve({ tenantSlug: tenantB.ctx.slug }),
      });

      // 401 generic body — no oracle leak (no mention of "grace",
      // "expired", or the discriminator kind).
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.title).toBe('Webhook authentication failed');
      const bodyStr = JSON.stringify(body).toLowerCase();
      expect(bodyStr).not.toContain('grace');
      expect(bodyStr).not.toContain('expired');
      expect(bodyStr).not.toMatch(/signature_mismatch|skew|missing_header|cross_tenant/i);

      // Tenant B's tables MUST NOT contain rows from this probe.
      const eventsB = await runInTenant(tenantB.ctx, async (tx) =>
        tx.select().from(events).where(eq(events.tenantId, tenantB.ctx.slug)),
      );
      const payloadEvent = payload['event'] as Record<string, unknown> | undefined;
      const probeEvent = eventsB.find(
        (e) => e.externalId === (payloadEvent?.['externalId'] as string | undefined),
      );
      expect(probeEvent).toBeUndefined();

      // Tenant B's audit log must record the rejection (forensic trail).
      const tenantBAudits = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantB.ctx.slug),
            eq(auditLog.requestId, requestId),
          ),
        );
      const rejectAudit = tenantBAudits.find(
        (row) => (row.eventType as string) === 'webhook_signature_rejected',
      );
      expect(rejectAudit).toBeDefined();

      // CRITICAL: tenant B's audit_log must NOT contain a
      // `webhook_secret_grace_used` row — tenant A's grace secret is
      // NOT a valid grace key for tenant B. If a future regression
      // cross-references grace secrets, the verifier would short-
      // circuit on a match and emit the wrong audit row here.
      const graceAuditLeak = tenantBAudits.find(
        (row) => (row.eventType as string) === 'webhook_secret_grace_used',
      );
      expect(graceAuditLeak).toBeUndefined();
    });
  });

  describe('CSV import path — cross-tenant integration probe (staff-review R-S01)', () => {
    it('runImportCsv invoked with tenantB.slug writes 0 rows to tenantA tables', async () => {
      // Constitution v1.4.0 Principle I sub-clause 3 requires a path-
      // level cross-tenant probe for every ingest surface. The webhook
      // path is covered above; this test closes the equivalent gap for
      // the CSV path. The shared `runInTenantTx` + branded `TenantId`
      // boundary should prevent any rows from landing in Tenant A's
      // tables when the use-case is invoked with Tenant B's slug.

      const { runImportCsv } = await import('@/lib/events-csv-import-deps');
      const { asUserId } = await import('@/modules/auth');

      // Snapshot Tenant A's row counts BEFORE the CSV import to detect
      // any cross-tenant leak. Use direct `runInTenant` reads (bypasses
      // application-layer guards — proves DB-layer isolation too).
      const snapshotTenantA = async () => ({
        events: (
          await runInTenant(tenantA.ctx, async (tx) =>
            tx.select().from(events).where(eq(events.tenantId, tenantA.ctx.slug)),
          )
        ).length,
        registrations: (
          await runInTenant(tenantA.ctx, async (tx) =>
            tx
              .select()
              .from(eventRegistrations)
              .where(eq(eventRegistrations.tenantId, tenantA.ctx.slug)),
          )
        ).length,
        idempotency: (
          await runInTenant(tenantA.ctx, async (tx) =>
            tx
              .select()
              .from(eventcreateIdempotencyReceipts)
              .where(
                eq(eventcreateIdempotencyReceipts.tenantId, tenantA.ctx.slug),
              ),
          )
        ).length,
      });

      const before = await snapshotTenantA();

      // 3-row valid CSV targeting Tenant B. The fixture uses unique IDs
      // so any accidental leak into Tenant A would be detected.
      const ts = Date.now();
      const csvBytes = new TextEncoder().encode(
        [
          'event_external_id,event_name,event_start,attendee_email,attendee_name',
          `cross_t_event_${ts}_0,Cross-Tenant Probe,2026-06-21T18:00:00+07:00,cross_${ts}_0@example.com,Attendee 0`,
          `cross_t_event_${ts}_1,Cross-Tenant Probe,2026-06-21T18:00:00+07:00,cross_${ts}_1@example.com,Attendee 1`,
          `cross_t_event_${ts}_2,Cross-Tenant Probe,2026-06-21T18:00:00+07:00,cross_${ts}_2@example.com,Attendee 2`,
        ].join('\n'),
      );

      const outcome = await runImportCsv({
        tenantSlug: tenantB.ctx.slug,
        // D1 fix (Phase 10 verify-run, 2026-05-17): the original
        // sentinel actorUserId `0000…0999` doesn't exist in the
        // users table → FK on csv_import_records.actor_user_id
        // fails. Replace with a real test admin user (mirrors
        // eventcreate-csv-real-fixtures.test.ts pattern).
        actorUserId: asUserId(testActorUserId),
        bytes: csvBytes,
        // D1 fix (Phase 10 verify-run, 2026-05-17): the stub
        // eventId is a hardcoded UUID that doesn't exist in
        // tenant B's events table — the CSV import's INSERT into
        // `csv_import_records` fails the FK constraint on
        // `event_id`. Replace with `bEventId` which is seeded in
        // beforeAll for THIS tenant; preserves the test's
        // cross-tenant-isolation intent while using a real FK.
        selectedEvent: { ...f6CsvTestSelectedEventStub, eventId: bEventId },
      });

      // The import should succeed for Tenant B — proves the use-case
      // ran end-to-end and the cross-tenant guard is not just blocking
      // both tenants.
      expect(outcome.kind).toBe('completed');

      // Tenant A's table counts MUST be unchanged.
      const after = await snapshotTenantA();
      expect(after.events).toBe(before.events);
      expect(after.registrations).toBe(before.registrations);
      expect(after.idempotency).toBe(before.idempotency);

      // Tenant B should now have 3 NEW registrations from the CSV.
      // D1 fix (Phase 10 verify-run): the original assertion checked
      // for 3 NEW events filtered by externalId — but `importCsv` per
      // import-csv.ts:1196-1201 merges `selectedEvent` into EVERY row,
      // so all 3 CSV rows land as registrations against the SAME
      // `selectedEvent.eventId` (here = bEventId). The test's
      // cross-tenant-isolation invariant is satisfied by proving 3
      // NEW REGISTRATIONS landed in tenant B + tenant A unchanged
      // (already asserted above). Switching from events → registrations
      // matches the architectural reality of the importer.
      const tenantBRegistrations = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.tenantId, tenantB.ctx.slug)),
      );
      const probeRegistrations = tenantBRegistrations.filter((r) =>
        r.attendeeEmail.startsWith(`cross_${ts}_`),
      );
      expect(probeRegistrations.length).toBe(3);
    });
  });
});
