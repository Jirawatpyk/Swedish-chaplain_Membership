/**
 * F7 → F3/F8 — a member's own broadcast actions count as activity.
 *
 * `member_acknowledged_broadcasts_terms` (member deliberately accepts the
 * GDPR Art. 7 consent banner) now carries snake `member_id`, so the F3
 * audit trigger (`audit_log_bump_member_last_activity`, migration 0009)
 * refreshes the member's `last_activity_at` — feeding the F3 directory
 * "last active" + the F8 at-risk recency proxy + the member timeline.
 *
 * (broadcast_submitted's snake `member_id` is gated to actorRole
 * `member_self_service` and unit-tested in
 * tests/unit/broadcasts/application/submit-broadcast.test.ts; this
 * integration test pins the end-to-end DB-trigger bump on the simpler,
 * un-gated acknowledge path.)
 *
 * Live Neon Singapore — the bump is a DB trigger; a mocked audit adapter
 * cannot catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  acknowledgeBroadcastsTerms,
  makeAcknowledgeBroadcastsTermsDeps,
  proxySubmitBroadcast,
  makeProxySubmitBroadcastDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
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

describe('F7 member broadcast action bumps members.last_activity_at', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const memberId = randomUUID();
  const OLD_ACTIVITY = new Date('2020-01-01T00:00:00.000Z');

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    const planId = `f7act-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'F7 Activity Plan' },
        description: { en: 'eblast plan' },
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
        createdBy: admin.userId,
        updatedBy: admin.userId,
      } as unknown as typeof membershipPlans.$inferInsert);
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'F7 Activity Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        // Not yet acknowledged → the ack is a fresh (non-idempotent) action.
        broadcastsAcknowledgedAt: null,
      } as unknown as typeof members.$inferInsert);
      await tx
        .update(members)
        .set({ lastActivityAt: OLD_ACTIVITY })
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId)));
    });
  });

  afterAll(async () => {
    try {
      await tenant.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
  });

  it('member acknowledging broadcasts terms ADVANCES last_activity_at', async () => {
    const deps = makeAcknowledgeBroadcastsTermsDeps(tenant.ctx.slug);
    const result = await acknowledgeBroadcastsTerms(deps, {
      memberId: asMemberId(memberId),
      actorUserId: admin.userId,
      locale: 'en',
      requestId: `f7act-${randomUUID().slice(0, 8)}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('fresh');

    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ lastActivityAt: members.lastActivityAt })
        .from(members)
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId))),
    );
    const lastActivityAt = rows[0]?.lastActivityAt;
    expect(lastActivityAt).toBeTruthy();
    expect(new Date(lastActivityAt as Date).getTime()).toBeGreaterThan(
      OLD_ACTIVITY.getTime(),
    );
  });
});

describe('F7 admin_proxy submit does NOT bump the proxied member recency', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const memberId = randomUUID();
  const OLD = new Date('2020-01-01T00:00:00.000Z');

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    const planId = `f7proxy-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'F7 Proxy Plan' },
        description: { en: 'eblast plan' },
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
        createdBy: admin.userId,
        updatedBy: admin.userId,
      } as unknown as typeof membershipPlans.$inferInsert);
      const recipientMemberId = randomUUID();
      await tx.insert(members).values([
        {
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'F7 Proxy Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
        // A second member so the all_members segment resolves to ≥1 recipient
        // (the sender is excluded from their own audience).
        {
          tenantId: tenant.ctx.slug,
          memberId: recipientMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'F7 Recipient Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
      ] as unknown as Array<typeof members.$inferInsert>);
      // Primary contacts: the sender needs one for reply-to; the recipient
      // member needs one to be a deliverable audience member.
      await tx.insert(contacts).values([
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Proxy',
          lastName: 'Member',
          email: 'proxy-member@f7proxy.example',
          isPrimary: true,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId: recipientMemberId,
          firstName: 'Recipient',
          lastName: 'Member',
          email: 'recipient@f7proxy.example',
          isPrimary: true,
        },
      ] as unknown as Array<typeof contacts.$inferInsert>);
      await tx
        .update(members)
        .set({ lastActivityAt: OLD })
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId)));
    });
  });

  afterAll(async () => {
    try {
      await tenant.cleanup();
    } catch {
      /* uuid-suffixed slug isolates other suites */
    }
  });

  it('a SUCCESSFUL admin proxy-submit leaves the member last_activity_at untouched', async () => {
    const deps = makeProxySubmitBroadcastDeps(tenant.ctx.slug);
    const result = await proxySubmitBroadcast(deps, {
      proxiedMemberId: memberId,
      adminUserId: admin.userId,
      tenantDisplayName: 'F7 Proxy Chamber',
      memberLookup: { status: 'found', companyName: 'F7 Proxy Co' },
      subject: 'Proxy submit recency probe',
      bodySource: '<p>hi</p>',
      bodyHtml: '<p>hi</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: `f7proxy-${randomUUID().slice(0, 8)}`,
    });
    // The submit itself must succeed (proves broadcast_submitted fired) …
    if (!result.ok) throw new Error('proxy submit failed: ' + JSON.stringify(result.error));
    expect(result.ok).toBe(true);

    // … but as an admin_proxy action it carries NO snake member_id, so the
    // F3 0009 trigger must NOT bump the proxied member's recency.
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ lastActivityAt: members.lastActivityAt })
        .from(members)
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId))),
    );
    expect(new Date(rows[0]?.lastActivityAt as Date).getTime()).toBe(OLD.getTime());
  });
});
