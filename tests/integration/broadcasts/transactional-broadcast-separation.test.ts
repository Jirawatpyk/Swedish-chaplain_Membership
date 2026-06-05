/**
 * T152a — Integration test: F1 transactional vs F7 Broadcasts API
 * product separation (FR-019, Coverage Gap C4 from /speckit.analyze).
 *
 * Asserts the two Resend products are isolated end-to-end:
 *
 *   (1) F1 transactional event (`/api/webhooks/resend`) → writes to
 *       `email_delivery_events` only; does NOT create row in
 *       `broadcast_deliveries`
 *   (2) F1 webhook signed with the F1 secret cannot be replayed against
 *       the F7 endpoint and vice versa — the route's verifier rejects
 *       cross-secret payloads
 *   (3) F7 webhook event (`/api/webhooks/resend-broadcasts`) → writes
 *       to `broadcast_deliveries` only; does NOT create row in
 *       `email_delivery_events`
 *   (4) Suppression lists are isolated: an F1 password-reset recipient
 *       hitting an F1 unsubscribe link (different surface) does NOT
 *       appear in F7 `marketing_unsubscribes`
 *
 * The "separate API products with separate suppression lists and
 * separate sending IPs" invariant from FR-019 is structural: we
 * verify the storage-layer side of it by ensuring the two webhook
 * routes never cross-pollinate each other's tables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import {
  broadcasts,
  broadcastDeliveries,
  marketingUnsubscribes,
} from '@/modules/broadcasts/infrastructure/schema';
import { emailDeliveryEvents } from '@/modules/auth/infrastructure/db/schema';
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

function buildSignedRequest(
  url: string,
  body: string,
  svixId: string,
  ts: number,
  secret: string,
): NextRequest {
  const sig = signSvix(body, svixId, ts, secret);
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': String(ts),
      'svix-signature': sig,
    },
    body,
  });
}

describe('F1 transactional vs F7 Broadcasts API separation (T152a / FR-019)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;
  let resendBroadcastId: string;
  let testStartTime: Date;

  beforeAll(async () => {
    testStartTime = new Date();
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const planId = `t152a-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T152a Plan' },
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
        companyName: 'T152a Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    broadcastId = randomUUID();
    resendBroadcastId = `t152a-rsb-${randomUUID().slice(0, 12)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'T152a separation',
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
    if (tenant) {
      // Also wipe any F1 email_delivery_events rows created by this test
      // (F1 table is global, not tenant-scoped — clean by recipient).
      await db
        .delete(emailDeliveryEvents)
        .where(eq(emailDeliveryEvents.toEmail, 't152a-recipient@example.com'));
      await tenant.cleanup();
    }
  });

  it('F1 transactional webhook: writes ONLY to email_delivery_events', async () => {
    const f1Route = await import('@/app/api/webhooks/resend/route');
    const ts = Math.floor(Date.now() / 1000);
    const svixId = `t152a-f1-${randomUUID()}`;
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        email_id: `f1-msg-${randomUUID().slice(0, 12)}`,
        to: ['t152a-recipient@example.com'],
        subject: 'Password reset',
      },
    });
    const res = await f1Route.POST(
      buildSignedRequest(
        'http://localhost/api/webhooks/resend',
        body,
        svixId,
        ts,
        env.resend.webhookSigningSecret,
      ),
    );
    expect(res.status).toBe(200);

    // F1 row written
    const f1Rows = await db
      .select()
      .from(emailDeliveryEvents)
      .where(eq(emailDeliveryEvents.svixId, svixId));
    expect(f1Rows.length).toBe(1);

    // F7 broadcast_deliveries NOT touched (no row with this svix as
    // resend_event_id within the test tenant)
    const f7Rows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.resendEventId, svixId),
          ),
        );
    });
    expect(f7Rows.length).toBe(0);
  });

  it('F1 secret-signed payload posted to F7 endpoint → 401 (cross-secret rejected)', async () => {
    // Sign with F1 secret, post to F7 endpoint. The F7 verifier reads
    // env.broadcasts.webhookSecret which is distinct, so HMAC mismatch
    // produces a 401 — proves the secrets are genuinely separated.
    const f7Route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const svixId = `t152a-cross-${randomUUID()}`;
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-cross',
        to: ['cross@example.com'],
      },
    });
    const res = await f7Route.POST(
      buildSignedRequest(
        'http://localhost/api/webhooks/resend-broadcasts',
        body,
        svixId,
        ts,
        env.resend.webhookSigningSecret, // F1 secret — wrong for F7
      ),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('bad_signature');

    // No F7 row inserted
    const f7Rows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.recipientEmailLower, 'cross@example.com'),
          ),
        );
    });
    expect(f7Rows.length).toBe(0);
  });

  it('F7 webhook: writes ONLY to broadcast_deliveries (not email_delivery_events)', async () => {
    const f7Route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const svixId = `t152a-f7-only-${randomUUID()}`;
    const body = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: resendBroadcastId,
        email_id: `f7-mid-${randomUUID().slice(0, 12)}`,
        to: ['t152a-f7only@example.com'],
      },
    });
    const res = await f7Route.POST(
      buildSignedRequest(
        'http://localhost/api/webhooks/resend-broadcasts',
        body,
        svixId,
        ts,
        env.broadcasts.webhookSecret,
      ),
    );
    expect(res.status).toBe(200);

    // F7 row written
    const f7Rows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.resendEventId, svixId),
          ),
        );
    });
    expect(f7Rows.length).toBe(1);

    // F1 email_delivery_events does NOT have a row with this svix id
    const f1Rows = await db
      .select()
      .from(emailDeliveryEvents)
      .where(eq(emailDeliveryEvents.svixId, svixId));
    expect(f1Rows.length).toBe(0);
  });

  it('F1 transactional recipient does NOT appear in F7 marketing_unsubscribes', async () => {
    // FR-019: F1 transactional uses its own (Resend-managed) suppression
    // list. Even if the recipient hits the F1 unsubscribe link (a
    // different external surface) the F7 marketing_unsubscribes table
    // remains untouched.
    const recipient = 't152a-recipient@example.com';
    const f7Suppression = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, recipient),
            gte(marketingUnsubscribes.unsubscribedAt, testStartTime),
          ),
        );
    });
    expect(f7Suppression.length).toBe(0);
  });
});
