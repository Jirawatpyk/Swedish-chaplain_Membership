/**
 * T039 — Idempotency integration test (F6).
 *
 * Spec authority:
 *   - research.md R3 (F6-owned eventcreate_idempotency_receipts table)
 *   - plan.md Testing § idempotency
 *   - data-model.md § 1.4
 *
 * Scenario (FR-004): same `X-Request-ID` delivered 5× MUST produce:
 *   - 1 event row
 *   - 1 registration row
 *   - 1 idempotency receipt
 *   - 1 `webhook_receipt_verified` audit
 *   - 4 `webhook_duplicate_rejected` audits
 *
 * Tests against live Neon Singapore via Wave 3.2 `makeIngestWebhookAttendeeDeps`
 * factory — the use-case manages its own tx + tenant context via the
 * deps `runInTenantTx` adapter (Constitution Principle III: Application
 * never imports drizzle-orm; tx boundary owned by Infrastructure).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  eventcreateIdempotencyReceipts,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

describe('T039 — F6 idempotency: 5× same X-Request-ID → 1 fresh + 4 duplicate', () => {
  let tenant: TestTenant;
  const REQUEST_ID = `req-test-idempotency-${Date.now()}-001`;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('5× delivery → 1 event + 1 registration + 1 fresh audit + 4 duplicate audits', async () => {
    const payload = makeWebhookPayload({
      event: { externalId: `event_idempotency_${Date.now()}` },
      attendee: { externalId: `att_idempotency_${Date.now()}` },
    });
    const deps = makeIngestWebhookAttendeeDeps();
    const callIngest = async () =>
      ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: REQUEST_ID,
          source: 'eventcreate_webhook',
          rawPayload: payload,
          sourceIp: '127.0.0.1',
        },
        deps,
      );

    const results = await Promise.all([
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
    ]);

    const fresh = results.filter((r) => r.ok).length;
    const dups = results.filter(
      (r) => r.ok === false && r.error.kind === 'duplicate_request_id',
    ).length;
    expect(fresh + dups).toBe(5);
    expect(fresh).toBe(1);
    expect(dups).toBe(4);

    // Persistence — exactly one event + one registration + one receipt
    const eventRows = await runInTenant(tenant.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.tenantId, tenant.ctx.slug)),
    );
    expect(eventRows.length).toBe(1);

    const regRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
    );
    expect(regRows.length).toBe(1);

    const receiptRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug),
            eq(eventcreateIdempotencyReceipts.requestId, REQUEST_ID),
          ),
        ),
    );
    expect(receiptRows.length).toBe(1);

    // Audit-trail — exactly 1 verified + 4 duplicate-rejected
    // Run with root db (audit_log RLS-permissive policy lets us read
    // across tenants from the owner role).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const verifiedCount = auditRows.filter(
      (r) => (r.eventType as string) === 'webhook_receipt_verified',
    ).length;
    const duplicateCount = auditRows.filter(
      (r) => (r.eventType as string) === 'webhook_duplicate_rejected',
    ).length;
    expect(verifiedCount).toBe(1);
    expect(duplicateCount).toBe(4);
  });

  it('S3 — FR-011 second idempotency layer: same attendee externalId + different request IDs → only one registration row', async () => {
    // Issue S3 (review 2026-05-12) — FR-011 specifies registration
    // `ON CONFLICT (tenant_id, event_id, external_id) DO NOTHING` as
    // a defence-in-depth second idempotency layer. The first layer
    // (X-Request-ID) is covered by the test above. This test exercises
    // the SECOND layer: an attacker (or buggy upstream) sending TWO
    // distinct `X-Request-ID`s for the same logical attendee
    // (`tenant + event + attendee.externalId`) MUST produce only ONE
    // registration row — the second call hits the unique index
    // `event_regs_tenant_event_external_unique` (migration 0131) and
    // returns `isNewRegistration=false`.
    const eventExternalId = `event_fr011_${Date.now()}`;
    const attendeeExternalId = `att_fr011_${Date.now()}`;
    const payloadA = makeWebhookPayload({
      event: { externalId: eventExternalId },
      attendee: { externalId: attendeeExternalId },
    });
    const payloadB = makeWebhookPayload({
      event: { externalId: eventExternalId },
      attendee: { externalId: attendeeExternalId }, // SAME attendee
    });
    const deps = makeIngestWebhookAttendeeDeps();

    const resA = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId: `req-fr011-a-${Date.now()}`,
        source: 'eventcreate_webhook',
        rawPayload: payloadA,
        sourceIp: '127.0.0.1',
      },
      deps,
    );
    const resB = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId: `req-fr011-b-${Date.now()}`, // DIFFERENT request id
        source: 'eventcreate_webhook',
        rawPayload: payloadB,
        sourceIp: '127.0.0.1',
      },
      deps,
    );

    // Both calls return ok (different X-Request-IDs → first layer
    // doesn't reject), but the second registration insert hits ON
    // CONFLICT → returns the original registration ID (idempotent).
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (resA.ok && resB.ok) {
      // Same registration row returned to both callers.
      expect(resB.value.registrationId).toBe(resA.value.registrationId);
      // Second call reports the event as NOT freshly created.
      expect(resB.value.eventCreated).toBe(false);
    }

    // DB invariant — exactly ONE registration row for this attendee.
    const regs = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.externalId, attendeeExternalId),
          ),
        ),
    );
    expect(regs.length).toBe(1);
  });

  it('R6-W8 — US1 AS2 invariant: non-member ingest emits ZERO quota audit events', async () => {
    // R6-W8 staff-review fix (2026-05-13): US1 AS2 spec states
    // "no quota is decremented, and the audit log entry records the
    // non-member outcome." The match-attendee unit + integration tests
    // assert the `non_member` resolution, but no test queries
    // audit_log to assert that quota event types
    // (`quota_partnership_decremented`, `quota_cultural_decremented`,
    // `quota_over_quota_warning`, `quota_credit_back_refund`,
    // `quota_credit_back_archive`) are NEVER emitted on the
    // non-member ingest path. Quota bugs without this guard would
    // accumulate silently and only surface at year-end reconciliation.
    const eventExternalId = `event_no_quota_${Date.now()}`;
    const attendeeExternalId = `att_no_quota_${Date.now()}`;
    const requestId = `req-no-quota-${Date.now()}`;
    const payload = makeWebhookPayload({
      event: { externalId: eventExternalId },
      attendee: {
        externalId: attendeeExternalId,
        // Use a domain that won't match any seeded member (test tenant
        // has no F3 members at all in this file → all ingests resolve
        // to `non_member` via Rule 4).
        email: `outsider@no-match-domain-${Date.now()}.example`,
      },
    });
    const deps = makeIngestWebhookAttendeeDeps();

    const result = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId,
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('non-member ingest should succeed');
    expect(result.value.matched).toBe('non_member');
    expect(result.value.quotaEffect.countedAgainstPartnership).toBe(false);
    expect(result.value.quotaEffect.countedAgainstCulturalQuota).toBe(false);

    // Query audit_log for any of the 5 quota event types tied to this
    // ingest. The match-resolution audit payloads (`attendee_*`) do
    // not carry `requestId` (only the receipt-verified + duplicate +
    // rolled-back payloads thread it). Correlate via `registrationId`
    // which IS present in the match-resolution payload shape.
    const registrationId = result.value.registrationId;
    const QUOTA_EVENT_TYPES = [
      'quota_partnership_decremented',
      'quota_cultural_decremented',
      'quota_over_quota_warning',
      'quota_credit_back_refund',
      'quota_credit_back_archive',
    ] as const;
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const ourQuotaRows = auditRows.filter(
      (r) =>
        (QUOTA_EVENT_TYPES as readonly string[]).includes(
          r.eventType as string,
        ) &&
        (r.payload as Record<string, unknown> | null)?.['registrationId'] ===
          registrationId,
    );
    expect(ourQuotaRows.length).toBe(0);

    // Sanity: the expected non_member audit row IS present (positive
    // control so a future bug that silences ALL audit emits on this
    // path doesn't pass the negative assertion alone).
    const nonMemberRows = auditRows.filter(
      (r) =>
        (r.eventType as string) === 'attendee_non_member' &&
        (r.payload as Record<string, unknown> | null)?.['registrationId'] ===
          registrationId,
    );
    expect(nonMemberRows.length).toBe(1);

    // PDPA/GDPR data-minimisation (go-live audit S1-P0-1): the non_member
    // audit payload must carry a SHA-256 hex prefix, NEVER the raw attendee
    // email. Guards against regressing the hash back to a raw-email field.
    const nmPayload = nonMemberRows[0]?.payload as Record<string, unknown>;
    expect(nmPayload?.['attendeeEmailHash']).toMatch(/^[0-9a-f]{16}$/);
    expect(nmPayload).not.toHaveProperty('attendeeEmail');
    expect(JSON.stringify(nmPayload)).not.toContain('@');
  });
});
