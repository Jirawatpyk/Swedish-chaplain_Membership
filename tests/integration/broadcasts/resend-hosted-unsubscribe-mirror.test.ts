/**
 * Live DB: an opt-out made on Resend's hosted unsubscribe page (or through
 * the List-Unsubscribe header Resend adds to every broadcast) reaches us as
 * `contact.updated {unsubscribed: true}` for a contact in a per-broadcast
 * Resend audience. `applyResendHostedUnsubscribe` must record it exactly as
 * our own page would — the tenant + email row in `marketing_unsubscribes`
 * and the `broadcast_unsubscribed` / `broadcast_suppression_applied` audit
 * pair — so the next E-Blast (a fresh audience) skips the address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import { broadcasts, marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { applyResendHostedUnsubscribe } from '@/modules/broadcasts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
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

describe('Resend hosted-page unsubscribe mirror (contact.updated)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;
  const audienceId = `aud-${randomUUID()}`;
  const email = `mirror-${randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    const planId = `mirror-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Mirror Plan' },
        description: { en: 'Test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
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
        companyName: 'Mirror Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'Mirror',
        bodyHtml: '<p>body</p>',
        bodySource: 'body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 1,
        status: 'sent',
        submittedAt: new Date(),
        sentAt: new Date(),
        quotaYearConsumed: 2026,
        quotaConsumedAt: new Date(),
        resendAudienceId: audienceId,
      }),
    );
  });

  afterAll(async () => {
    if (tenant) {
      try {
        await db.execute(sql`DELETE FROM marketing_unsubscribes WHERE tenant_id = ${tenant.ctx.slug}`);
      } catch {
        // best-effort
      }
      await tenant.cleanup();
    }
  });

  async function rows() {
    return runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, email),
          ),
        ),
    );
  }

  async function audits(eventType: string) {
    return (await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = ${eventType}::audit_event_type
    `)) as unknown as ReadonlyArray<{ payload: Record<string, unknown> }>;
  }

  it('records a tenant-wide opt-out with the same row + audit pair as our own page', async () => {
    const r = await applyResendHostedUnsubscribe({
      email: email.toUpperCase(),
      audienceIds: ['seg-unrelated', audienceId],
      requestId: randomUUID(),
    });
    expect(r).toEqual({ kind: 'applied', tenantId: tenant.ctx.slug, attributed: true });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.reason).toBe('recipient_initiated');
    expect(stored[0]!.sourceBroadcastId).toBe(broadcastId);
    expect(stored[0]!.sourceTokenHash).toBeNull();

    for (const type of ['broadcast_unsubscribed', 'broadcast_suppression_applied']) {
      const a = await audits(type);
      expect(a).toHaveLength(1);
      expect(a[0]!.payload['channel']).toBe('resend_hosted');
      expect(JSON.stringify(a[0]!.payload)).not.toContain(email);
    }
  });

  it('a replay changes nothing and writes no second audit', async () => {
    const r = await applyResendHostedUnsubscribe({
      email,
      audienceIds: [audienceId],
      requestId: randomUUID(),
    });
    expect(r).toEqual({ kind: 'already', tenantId: tenant.ctx.slug, attributed: true });
    expect(await rows()).toHaveLength(1);
    expect(await audits('broadcast_unsubscribed')).toHaveLength(1);
  });

  // cleanup-audiences reaps each audience an hour after send, so a late click
  // arrives with an id no broadcast owns. The objection must still land —
  // under this (single-tenant) deployment's tenant, with no source broadcast.
  it('an audience no broadcast owns is filed under the deployment tenant, not dropped', async () => {
    const lateEmail = `mirror-late-${randomUUID().slice(0, 8)}@example.com`;
    const { env } = await import('@/lib/env');
    try {
      const r = await applyResendHostedUnsubscribe({
        email: lateEmail,
        audienceIds: [`aud-${randomUUID()}`],
        requestId: randomUUID(),
      });
      expect(r).toEqual({ kind: 'applied', tenantId: env.tenant.slug, attributed: false });
      const [row] = (await db.execute(sql`
        SELECT source_broadcast_id FROM marketing_unsubscribes
         WHERE tenant_id = ${env.tenant.slug} AND email_lower = ${lateEmail}
      `)) as unknown as Array<{ source_broadcast_id: string | null }>;
      expect(row).toBeDefined();
      expect(row!.source_broadcast_id).toBeNull();
    } finally {
      await db.execute(sql`
        DELETE FROM marketing_unsubscribes WHERE email_lower = ${lateEmail}
      `);
    }
  });

  // Security review T1: the opt-out lands ONLY in the tenant that owns the
  // audience — never in another tenant's suppression list.
  it('attributes to the audience-owning tenant only', async () => {
    const other = await createTestTenant('test-swecham');
    try {
      const otherEmail = `mirror-x-${randomUUID().slice(0, 8)}@example.com`;
      const r = await applyResendHostedUnsubscribe({
        email: otherEmail,
        audienceIds: [audienceId],
        requestId: randomUUID(),
      });
      expect(r).toEqual({ kind: 'applied', tenantId: tenant.ctx.slug, attributed: true });
      const inOther = await runInTenant(other.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(eq(marketingUnsubscribes.tenantId, other.ctx.slug)),
      );
      expect(inOther).toHaveLength(0);
    } finally {
      await other.cleanup();
    }
  });
});

