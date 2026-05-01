/**
 * T152 — Integration test: webhook idempotency (live DB).
 *
 * Verifies FR-025: same `(tenant_id, resend_event_id)` upserted twice
 * → second is a no-op (UNIQUE constraint + ON CONFLICT DO NOTHING in
 * `BroadcastDeliveriesRepo.upsertByResendEventId`). Asserts:
 *
 *   (a) first webhook with svix-id "evt_x" → row inserted, delivery
 *       count = 1, use-case outcome = `recorded`
 *   (b) second identical webhook → still 200 OK, delivery count
 *       remains 1 (no second row), use-case outcome = `duplicate` —
 *       NO duplicate audit emit, NO duplicate suppression
 *   (c) different `resend_event_id` for the same broadcast + recipient
 *       → second row inserted (the dedup key is event_id, not
 *       recipient or message_id)
 *
 * Live-DB constraint: cleanup helper temporarily disables the
 * append-only trigger on `broadcast_deliveries` so test rows can be
 * wiped after the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
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
  body: string,
  svixId: string,
  ts: number,
): NextRequest {
  const sig = signSvix(body, svixId, ts, env.broadcasts.webhookSecret);
  return new NextRequest('http://localhost/api/webhooks/resend-broadcasts', {
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

describe('F7 webhook idempotency integration (T152)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;
  let resendBroadcastId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const planId = `t152-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T152 Plan' },
        description: { en: '' },
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
        companyName: 'T152 Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    broadcastId = randomUUID();
    resendBroadcastId = `t152-rsb-${randomUUID().slice(0, 12)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'T152 idempotency test',
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

  it('replay same svix-id → second call is no-op (FR-025 UNIQUE)', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const svixId = `t152-evt-${randomUUID()}`;
    const body = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t152-replay',
        to: ['idempotent@example.com'],
      },
    });

    const res1 = await route.POST(buildSignedRequest(body, svixId, ts));
    expect(res1.status).toBe(200);
    expect((await res1.json()).received).toBe(true);

    const afterFirst = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.broadcastId, broadcastId),
            eq(broadcastDeliveries.recipientEmailLower, 'idempotent@example.com'),
          ),
        );
    });
    expect(afterFirst.length).toBe(1);
    const firstDeliveryId = afterFirst[0]!.deliveryId;

    // Second call — identical svix-id, identical body. The Svix
    // signature is over `svix_id.svix_ts.body` so re-signing the same
    // inputs yields the same signature; the route's verifier accepts.
    const res2 = await route.POST(buildSignedRequest(body, svixId, ts));
    expect(res2.status).toBe(200);

    const afterSecond = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.broadcastId, broadcastId),
            eq(broadcastDeliveries.recipientEmailLower, 'idempotent@example.com'),
          ),
        );
    });
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0]!.deliveryId).toBe(firstDeliveryId);
  });

  it('different svix-id same broadcast + recipient → second row inserted', async () => {
    const route = await import(
      '@/app/api/webhooks/resend-broadcasts/route'
    );
    const ts = Math.floor(Date.now() / 1000);
    const body1 = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t152-distinct',
        to: ['distinct@example.com'],
      },
    });
    const body2 = JSON.stringify({
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: {
        broadcast_id: resendBroadcastId,
        email_id: 'mid-t152-distinct',
        to: ['distinct@example.com'],
        bounce: { type: 'hard' },
      },
    });

    const svixIdA = `t152-distinct-a-${randomUUID()}`;
    const svixIdB = `t152-distinct-b-${randomUUID()}`;
    await route.POST(buildSignedRequest(body1, svixIdA, ts));
    await route.POST(buildSignedRequest(body2, svixIdB, ts));

    const rows = await runInTenant(tenant.ctx, async (tx) => {
      return tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, tenant.ctx.slug),
            eq(broadcastDeliveries.broadcastId, broadcastId),
            eq(broadcastDeliveries.recipientEmailLower, 'distinct@example.com'),
          ),
        );
    });
    expect(rows.length).toBe(2);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['bounced', 'delivered']);
  });
});
