/**
 * Integration — bulkSendPortalInvite (go-live P1-17, live Neon).
 *
 * Proves the END-TO-END bulk path with REAL adapters (buildMembersDeps →
 * invitePortal → F1 createUser → notifications_outbox enqueue):
 *   - HAPPY: N members with an unlinked primary contact → N `member_invitation`
 *     outbox rows (status=pending, tenant_id=tenant slug) + the contacts linked.
 *   - IDEMPOTENT: an already-linked contact → skipped(already_linked), no new
 *     outbox row.
 *   - TENANT ISOLATION (Principle I): a member id from another tenant in this
 *     tenant's request → skipped(member_not_found) under RLS, zero cross-tenant
 *     invite. The existing /api/cron/outbox-dispatch cron remains the email
 *     sender + throttle (untouched).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { bulkSendPortalInvite } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { notificationsOutbox, users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-bulk-invite-plan';
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

async function seedPlan(slug: string, userId: string): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Bulk Invite Plan' },
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
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedMember(
  tenant: TestTenant,
  opts: { email: string; isPrimary?: boolean; linkedUserId?: string | null },
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `BulkInviteCo ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
      archivedAt: null,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Bulk',
      lastName: 'Invitee',
      email: opts.email,
      preferredLanguage: 'en',
      isPrimary: opts.isPrimary ?? true,
      linkedUserId: opts.linkedUserId ?? null,
      removedAt: null,
    });
  });
  return memberId;
}

describe('F3 bulkSendPortalInvite — integration (P1-17, live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const sfx = randomUUID().slice(0, 8);
  const emailM1 = `bulk-inv-m1-${sfx}@swecham.test`;
  const emailM2 = `bulk-inv-m2-${sfx}@swecham.test`;
  const emailM3 = `bulk-inv-m3-${sfx}@swecham.test`; // pre-linked
  const emailMB = `bulk-inv-mb-${sfx}@swecham.test`;
  const allEmails = [emailM1, emailM2, emailM3, emailMB];
  let m1: string, m2: string, m3: string, mB: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seedPlan(tenantA.ctx.slug, admin.userId);
    await seedPlan(tenantB.ctx.slug, admin.userId);
    m1 = await seedMember(tenantA, { email: emailM1 });
    m2 = await seedMember(tenantA, { email: emailM2 });
    // m3: contact already linked to a real user → invitePortal returns already_linked.
    m3 = await seedMember(tenantA, { email: emailM3, linkedUserId: admin.userId });
    mB = await seedMember(tenantB, { email: emailMB });
  }, 180_000);

  afterAll(async () => {
    for (const email of allEmails) {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.toEmail, email.toLowerCase())).catch(() => {});
      await db.delete(users).where(eq(users.email, email.toLowerCase())).catch(() => {});
    }
    for (const t of [tenantA, tenantB]) {
      const slug = t?.ctx.slug;
      if (!slug) continue;
      await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
      await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug)).catch(() => {});
    }
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  function depsFor(t: TestTenant) {
    const d = buildMembersDeps(t.ctx);
    return {
      tenant: d.tenant,
      memberRepo: d.memberRepo,
      contactRepo: d.contactRepo,
      createUser: d.createUser,
      deleteInvitedUser: d.deleteInvitedUser,
      // Phase D / Task 13 — the already_linked arm now falls through to
      // resendBouncedInvite, which needs these; all provided by buildMembersDeps.
      reissueInvitation: d.reissueInvitation,
      userEmails: d.userEmails,
      audit: d.audit,
      clock: d.clock,
    };
  }
  const meta = (rid: string) => ({ actorUserId: admin.userId, requestId: rid, sourceIp: '203.0.113.9' });

  it('HAPPY: invites unlinked members → member_invitation outbox rows queued', async () => {
    const r = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [m1, m2] },
      meta(`bulk-inv-happy-${sfx}`),
      depsFor(tenantA),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Phase D / Task 13 added the `resent` bucket — assert its presence (0
    // here, both contacts are unlinked) rather than dropping it silently.
    expect(r.value.counts).toEqual({ invited: 2, resent: 0, skipped: 0, failed: 0 });

    const outbox = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          inArray(notificationsOutbox.toEmail, [emailM1.toLowerCase(), emailM2.toLowerCase()]),
          eq(notificationsOutbox.notificationType, 'member_invitation'),
          eq(notificationsOutbox.tenantId, tenantA.ctx.slug),
        ),
      );
    expect(outbox).toHaveLength(2);
    expect(outbox.every((o) => o.status === 'pending')).toBe(true);
  }, 60_000);

  it('IDEMPOTENT: an already-linked contact → skipped(already_linked), no outbox', async () => {
    const r = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [m3] },
      meta(`bulk-inv-idem-${sfx}`),
      depsFor(tenantA),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toEqual([{ memberId: m3, reason: 'already_linked' }]);
    const outbox = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.toEmail, emailM3.toLowerCase()));
    expect(outbox).toHaveLength(0);
  }, 60_000);

  it('TENANT ISOLATION: another tenant member id → skipped(member_not_found), no cross-tenant invite', async () => {
    const r = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [mB] }, // tenant B's member, run under tenant A
      meta(`bulk-inv-xt-${sfx}`),
      depsFor(tenantA),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skipped).toEqual([{ memberId: mB, reason: 'member_not_found' }]);
    const outbox = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.toEmail, emailMB.toLowerCase()));
    expect(outbox).toHaveLength(0);
  }, 60_000);
});
