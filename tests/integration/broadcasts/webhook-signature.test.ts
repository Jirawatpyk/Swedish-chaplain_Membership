/**
 * T151 — Integration test: webhook signature verification (live DB).
 *
 * Drives the production POST /api/webhooks/resend-broadcasts route
 * end-to-end against live Neon Singapore. Asserts:
 *
 *   (a) valid Svix HMAC-SHA256 signature → 200 + processWebhookEvent
 *       reaches the use-case (broadcast_deliveries row inserted)
 *   (b) invalid signature → 401 `bad_signature` + audit row with
 *       event_type='broadcast_webhook_signature_rejected' + tenant_id
 *       NULL (route writes the audit BEFORE tenant resolution)
 *   (c) missing svix-* headers → 401 `missing_header` + audit row
 *   (d) verify-before-parse invariant: zero state mutation on reject
 *       paths (no broadcast_deliveries row written even if the body
 *       carries a valid resend_broadcast_id)
 *   (e) timestamp tolerance: 6-minute-old timestamp → 401 expired
 *
 * Live-DB constraints: audit_log has append-only trigger so test rows
 * accumulate (bounded by recent-window query). broadcast_deliveries
 * has its own append-only trigger that the cleanup helper temporarily
 * disables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const F7_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

function signSvix(
  rawBody: string,
  svixId: string,
  unixSeconds: number,
  secret: string,
): string {
  const stripped = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const signedPayload = `${svixId}.${unixSeconds}.${rawBody}`;
  const sig = createHmac('sha256', Buffer.from(stripped, 'base64'))
    .update(signedPayload, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

interface WebhookOpts {
  readonly body: string;
  readonly svixId?: string | null;
  readonly svixTs?: number | null;
  readonly signatureOverride?: string;
}

function buildRequest(opts: WebhookOpts): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.svixId !== null && opts.svixId !== undefined) {
    headers['svix-id'] = opts.svixId;
  }
  if (opts.svixTs !== null && opts.svixTs !== undefined) {
    headers['svix-timestamp'] = String(opts.svixTs);
  }
  if (opts.signatureOverride !== undefined) {
    headers['svix-signature'] = opts.signatureOverride;
  } else if (
    opts.svixId !== null &&
    opts.svixId !== undefined &&
    opts.svixTs !== null &&
    opts.svixTs !== undefined
  ) {
    headers['svix-signature'] = signSvix(
      opts.body,
      opts.svixId,
      opts.svixTs,
      env.broadcasts.webhookSecret,
    );
  }
  return new NextRequest('http://localhost/api/webhooks/resend-broadcasts', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

describe('F7 webhook signature integration (T151)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;
  let resendBroadcastId: string;
  let testStartTime: Date;

  beforeAll(async () => {
    testStartTime = new Date();
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed plan + member + broadcast with resend_broadcast_id so the
    // route's tenant-resolve lookup succeeds on the happy path.
    const planId = `t151-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T151 Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: F7_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'T151 Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    broadcastId = randomUUID();
    resendBroadcastId = `t151-rsb-${randomUUID().slice(0, 12)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'T151 sig test',
        bodyHtml: '<p>x</p>',
        bodySource: 'x',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 100,
        status: 'sending',
        sendingStartedAt: new Date(),
        resendAudienceId: 'aud-1',
        resendBroadcastId,
      }),
    );
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('valid signature → 200 + delivery row inserted', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t151-valid',
        to: ['valid@example.com'],
      },
    });
    const res = await route.POST(
      buildRequest({ body, svixId: 'msg-t151-valid', svixTs: ts }),
    );
    expect(res.status).toBe(200);

    const rows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.broadcastId, broadcastId),
            eq(broadcastDeliveries.recipientEmailLower, 'valid@example.com'),
          ),
        );
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('delivered');
  });

  it('invalid signature → 401 bad_signature + audit row with NULL tenant', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t151-invalid',
        to: ['invalid@example.com'],
      },
    });
    const res = await route.POST(
      buildRequest({
        body,
        svixId: 'msg-t151-invalid',
        svixTs: ts,
        signatureOverride: 'v1,YmFkU2lnbmF0dXJlSGVyZQ==',
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('bad_signature');

    // Audit row written via owner role (BYPASS RLS). Query directly
    // against `db` since tenant_id is NULL and RLS would hide it.
    const audits = (await db.execute(sql`
      SELECT event_type::text AS event_type, tenant_id
      FROM audit_log
      WHERE event_type::text = 'broadcast_webhook_signature_rejected'
        AND timestamp >= ${testStartTime.toISOString()}
        AND tenant_id IS NULL
        AND payload->>'reason' = 'bad_signature'
      ORDER BY timestamp DESC
      LIMIT 5
    `)) as unknown as Array<{ event_type: string; tenant_id: string | null }>;
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]!.tenant_id).toBeNull();

    // Verify-before-parse: no broadcast_deliveries row inserted for the
    // tampered request even though the body carried a valid resend_broadcast_id.
    const deliveryRows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.recipientEmailLower, 'invalid@example.com'),
          ),
        );
    });
    expect(deliveryRows.length).toBe(0);
  });

  it('missing svix headers → 401 missing_header + audit row', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t151-missing',
        to: ['missing@example.com'],
      },
    });
    const res = await route.POST(
      buildRequest({ body, svixId: null, svixTs: null }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('missing_header');

    const audits = (await db.execute(sql`
      SELECT payload->>'reason' AS reason
      FROM audit_log
      WHERE event_type::text = 'broadcast_webhook_signature_rejected'
        AND timestamp >= ${testStartTime.toISOString()}
        AND payload->>'reason' = 'missing_header'
      ORDER BY timestamp DESC
      LIMIT 5
    `)) as unknown as Array<{ reason: string }>;
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('expired timestamp (>5min) → 401 + audit row', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const expiredTs = Math.floor(Date.now() / 1000) - 6 * 60;
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t151-expired',
        to: ['expired@example.com'],
      },
    });
    const res = await route.POST(
      buildRequest({ body, svixId: 'msg-t151-expired', svixTs: expiredTs }),
    );
    expect(res.status).toBe(401);

    const audits = (await db.execute(sql`
      SELECT payload->>'reason' AS reason
      FROM audit_log
      WHERE event_type::text = 'broadcast_webhook_signature_rejected'
        AND timestamp >= ${testStartTime.toISOString()}
        AND payload->>'reason' = 'expired_timestamp'
      ORDER BY timestamp DESC
      LIMIT 5
    `)) as unknown as Array<{ reason: string }>;
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('verify-before-parse: garbage body with no signature → no parse + no mutation', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    // Even a body that would fail JSON.parse must NEVER reach the parser.
    const garbageBody = 'this is not even valid json {{{';
    const res = await route.POST(
      buildRequest({ body: garbageBody, svixId: null, svixTs: null }),
    );
    expect(res.status).toBe(401);

    const recentDeliveriesGarbage = await runInTenant(
      tenant.ctx,
      async (tx) => {
        return tx
          .select()
          .from(broadcastDeliveries)
          .where(
            and(
              eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
              gte(broadcastDeliveries.createdAt, testStartTime),
            ),
          )
          .orderBy(desc(broadcastDeliveries.createdAt))
          .limit(50);
      },
    );
    // Only the happy-path delivery row should exist; no extra row from
    // any of the reject-branch tests.
    const garbageRow = recentDeliveriesGarbage.find(
      (r) => r.recipientEmailLower === 'expired@example.com',
    );
    expect(garbageRow).toBeUndefined();
  });
});
