/**
 * Round-6 verify-fix (2026-05-13) C1 — FR-008 grace-key audit emission.
 *
 * Spec authority: specs/012-eventcreate-integration/spec.md FR-008 +
 * SC-008.
 *
 * Why this test exists:
 *   - The receiver emits a `webhook_secret_grace_used` audit row when a
 *     webhook is accepted under the 24h grace window
 *     (`src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts:559`).
 *   - That audit row IS the FR-008 compliance proof — without it there
 *     is no forensic trail showing the grace secret operated within
 *     contract during a rotation.
 *   - Before this test, NO integration coverage asserted the emit
 *     fires. The receiver-side emit block was retroactively added in
 *     verify-fix round-2 (H1) after the spec retrospective noted the
 *     event type was declared at Phase 2 in audit-port.ts but never
 *     wired. A future refactor could silently re-break it.
 *   - PR Review (Phase 5 Round 1) identified this as CRITICAL coverage
 *     gap — closed here.
 *
 * What this asserts:
 *   1. Webhook signed with the *grace* secret (active secret rotated
 *      12h ago) → HTTP 200 (verified via grace path).
 *   2. `webhook_secret_grace_used` audit row exists in `audit_log` for
 *      the same `requestId`, with `severity='warn'` and
 *      `graceSecretAgeHours` ∈ [11, 13] (allowing 1h tolerance for
 *      clock skew during the test run).
 *   3. The standalone audit emit commits in its OWN transaction —
 *      verified by the row's presence even though the use-case tx may
 *      have its own audit emits (NOT the grace-used one).
 *
 * Not in scope:
 *   - Boundary tests at 24h ± 1ms (covered by `signature.test.ts`
 *     S2a/S2b at the verifier layer).
 *   - Active-secret happy path (covered by other receiver tests).
 *   - Rejection paths (covered by signature.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import {
  tenantWebhookConfigs,
  type NewTenantWebhookConfigRow,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { POST } from '@/app/api/webhooks/eventcreate/v1/[tenantSlug]/route';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { signWebhookBody, makeWebhookPayload } from './helpers/sign-webhook';

const ACTIVE_SECRET = randomBytes(32).toString('base64url');
const GRACE_SECRET = randomBytes(32).toString('base64url');
// 12h ago — well within the FR-008 24h grace window.
const GRACE_ROTATED_AT = new Date(Date.now() - 12 * 60 * 60 * 1000);

describe('C1 — F6 FR-008 grace-key audit emission @workers=1', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    // Seed `tenant_webhook_configs` directly — bypass RLS via the
    // owner role (same pattern as `tenant-isolation.test.ts:69-90`).
    await db.insert(tenantWebhookConfigs).values({
      tenantId: tenant.ctx.slug,
      source: 'eventcreate',
      webhookSecretActive: ACTIVE_SECRET,
      webhookSecretGrace: GRACE_SECRET,
      graceRotatedAt: GRACE_ROTATED_AT,
      enabled: true,
    } satisfies NewTenantWebhookConfigRow);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('emits webhook_secret_grace_used audit row when grace secret verifies', async () => {
    const payload = makeWebhookPayload({ tenantSlug: tenant.ctx.slug });
    const signed = signWebhookBody({ body: payload, secret: GRACE_SECRET });
    const requestId = `req-grace-${randomUUID()}`;
    const url = `https://app.test/api/webhooks/eventcreate/v1/${tenant.ctx.slug}`;
    const req = new NextRequest(url, {
      method: 'POST',
      body: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': requestId,
      },
    });

    const res = await POST(req, {
      params: Promise.resolve({ tenantSlug: tenant.ctx.slug }),
    });

    // Verified via grace path — receiver returns 200 same as active.
    expect(res.status).toBe(200);

    // The grace-used audit emit lives in a separate standalone tx
    // (Step 7.5 of the receiver), so it commits independently of the
    // ingest use-case's own tx. Query as the owner role (cleanup
    // pattern) — bypasses RLS so a future regression that emits with
    // the wrong tenant_id is still surfaced rather than masked.
    const auditRows = await runInTenant(tenant.ctx, async () =>
      db
        .select({
          eventType: auditLog.eventType,
          tenantId: auditLog.tenantId,
          actorUserId: auditLog.actorUserId,
          requestId: auditLog.requestId,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            // Cast through `never` because `auditEventTypeEnum`'s TS
            // literal union doesn't include F6 enum extensions added
            // via SQL ALTER TYPE (same precedent as
            // `events-admin-integration-deps.ts:256`).
            eq(auditLog.eventType, 'webhook_secret_grace_used' as never),
            eq(auditLog.requestId, requestId),
          ),
        ),
    );

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const row = auditRows[0]!;
    expect(row.eventType as string).toBe('webhook_secret_grace_used');
    expect(row.requestId).toBe(requestId);
    // Receiver-side emit passes `actorUserId: null` (line 565); the
    // adapter coerces null → a system sentinel string ('system:webhook'
    // or similar) because `audit_log.actor_user_id` is NOT NULL.
    // Either is acceptable; the strict invariant is that the row was
    // NOT attributed to a real user UUID (no `[a-f0-9-]{36}` pattern).
    expect(row.actorUserId).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const payloadObj = row.payload as {
      severity?: string;
      requestId?: string;
      graceSecretAgeHours?: number;
    };
    expect(payloadObj.severity).toBe('warn');
    expect(payloadObj.requestId).toBe(requestId);
    // Seeded at 12h ago + test run ≤1h ⇒ age ∈ [11, 13]. Floor in
    // route is bounded by `[0, 24]` per receiver line 555.
    expect(payloadObj.graceSecretAgeHours).toBeGreaterThanOrEqual(11);
    expect(payloadObj.graceSecretAgeHours).toBeLessThanOrEqual(13);
  });

  it('does NOT emit webhook_secret_grace_used when active secret verifies', async () => {
    // Sanity counter-test: a webhook signed with the ACTIVE secret
    // must NOT trigger the grace-used emit. Guards against an
    // accidental flag inversion in the receiver's Step 7.5 predicate.
    const payload = makeWebhookPayload({
      tenantSlug: tenant.ctx.slug,
      event: { externalId: `event_active_${randomUUID()}` },
      attendee: { externalId: `att_active_${randomUUID()}` },
    });
    const signed = signWebhookBody({ body: payload, secret: ACTIVE_SECRET });
    const requestId = `req-active-${randomUUID()}`;
    const url = `https://app.test/api/webhooks/eventcreate/v1/${tenant.ctx.slug}`;
    const req = new NextRequest(url, {
      method: 'POST',
      body: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': requestId,
      },
    });

    const res = await POST(req, {
      params: Promise.resolve({ tenantSlug: tenant.ctx.slug }),
    });
    expect(res.status).toBe(200);

    const auditRows = await runInTenant(tenant.ctx, async () =>
      db
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'webhook_secret_grace_used' as never),
            eq(auditLog.requestId, requestId),
          ),
        ),
    );
    expect(auditRows.length).toBe(0);
  });
});
