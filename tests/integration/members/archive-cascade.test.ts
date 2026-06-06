/**
 * T135 — Integration: archive-member on live Neon (US7 AS1, AS4).
 *
 * Verifies:
 *   1. Archive flips status to 'archived' + sets archived_at
 *   2. Linked F1 user sessions are revoked in the SAME tx (cascade)
 *   3. member_archived + user_sessions_revoked audit events are written
 *   4. Re-archive on an already-archived member returns state_error
 *   5. Cross-tenant archive returns not_found (RLS isolation)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { archiveMember, asMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  invitations,
  sessions,
} from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
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

async function seedPlan(tenantSlug: string, userId: string, planId: string) {
  await runInTenant({ slug: tenantSlug } as never, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenantSlug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100000n,
      legalNameTh: 'Test TH',
      legalNameEn: 'Test EN',
      taxId: '0000000000000',
      registeredAddressTh: 'Test Address TH',
      registeredAddressEn: 'Test Address EN',
      invoiceNumberPrefix: 'INV',
      creditNoteNumberPrefix: 'CN',
    });
    await tx.insert(membershipPlans).values({
      tenantId: tenantSlug,
      planId,
      planYear: 2026,
      planName: { en: 'Archive Test Plan' },
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
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedMember(
  tenant: TestTenant,
  planId: string,
  opts: { linkedUserId?: string | null } = {},
): Promise<{ memberId: string; contactId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Archive Co ${Date.now()}`,
      country: 'TH',
      planId,
      planYear: 2026,
      registrationDate: new Date().toISOString().slice(0, 10),
      registrationFeePaid: false,
      status: 'active',
      archivedAt: null,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Anna',
      lastName: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: opts.linkedUserId ?? null,
      removedAt: null,
    });
  });
  return { memberId, contactId };
}

describe('archive-member integration (T135, US7)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-archive-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    await seedPlan(tenant.ctx.slug, user.userId, planId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('archives a member: flips status + sets archived_at + audit row', async () => {
    const { memberId } = await seedMember(tenant, planId);
    const deps = buildMembersDeps(tenant.ctx);
    const result = await archiveMember(
      asMemberId(memberId),
      { reason: 'Company closed' },
      { actorUserId: user.userId, requestId: `rq-arch-${Date.now()}` },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('archived');
    expect(result.value.archivedAt).not.toBeNull();

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(rows[0]?.status).toBe('archived');
    expect(rows[0]?.archivedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_archived'),
        ),
      );
    const match = audits.find(
      (r) => (r.payload as { member_id?: string })?.member_id === memberId,
    );
    expect(match).toBeDefined();
    expect(
      (match!.payload as { reason?: string | null })?.reason,
    ).toBe('Company closed');
  });

  it('cascade: revokes sessions of linked F1 user on archive', async () => {
    // Create a member linked to a real F1 user + seed an active session
    const linkedUser = await createActiveTestUser('member');
    const { memberId } = await seedMember(tenant, planId, {
      linkedUserId: linkedUser.userId,
    });

    // Seed a session for the linked user — 32-byte hex id per schema.ts
    const sessionId = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await db.insert(sessions).values({
      id: sessionId,
      userId: linkedUser.userId,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      sourceIp: '127.0.0.1',
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await archiveMember(
      asMemberId(memberId),
      {},
      { actorUserId: user.userId, requestId: `rq-arch-${Date.now()}` },
      deps,
    );
    expect(result.ok).toBe(true);

    // Session should be deleted
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, linkedUser.userId));
    expect(remaining).toHaveLength(0);

    // user_sessions_revoked audit event emitted
    const revokedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'user_sessions_revoked'),
        ),
      );
    const match = revokedAudits.find(
      (r) => (r.payload as { member_id?: string })?.member_id === memberId,
    );
    expect(match).toBeDefined();
    expect(
      (match!.payload as { reason?: string })?.reason,
    ).toBe('admin_force_archive');
  });

  it('re-archive returns state_error', async () => {
    const { memberId } = await seedMember(tenant, planId);
    const deps = buildMembersDeps(tenant.ctx);

    const first = await archiveMember(
      asMemberId(memberId),
      {},
      { actorUserId: user.userId, requestId: `rq-arch-1-${Date.now()}` },
      deps,
    );
    expect(first.ok).toBe(true);

    const second = await archiveMember(
      asMemberId(memberId),
      {},
      { actorUserId: user.userId, requestId: `rq-arch-2-${Date.now()}` },
      deps,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.type).toBe('state_error');
      if (second.error.type === 'state_error') {
        expect(second.error.code).toBe(
          'state.cannot_archive_already_archived',
        );
      }
    }
  });

  it('cascade: dedupes same F1 user linked to multiple contacts (R002)', async () => {
    // Seed a member with 2 contacts both linked to the SAME F1 user — rare
    // but legal (e.g. one person holding two role titles). Without Set
    // dedupe this would emit TWO `user_sessions_revoked` audit rows for
    // the same user; with dedupe we expect exactly ONE.
    const linkedUser = await createActiveTestUser('member');
    const memberId = randomUUID();
    const primaryContactId = randomUUID();
    const secondaryContactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `DedupeCo ${Date.now()}`,
        country: 'TH',
        planId,
        planYear: 2026,
        registrationDate: new Date().toISOString().slice(0, 10),
        registrationFeePaid: false,
        status: 'active',
        archivedAt: null,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: primaryContactId,
        memberId,
        firstName: 'Anna',
        lastName: 'Primary',
        email: `anna-primary-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: 'CEO',
        preferredLanguage: 'en',
        isPrimary: true,
        dateOfBirth: null,
        linkedUserId: linkedUser.userId,
        removedAt: null,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: secondaryContactId,
        memberId,
        firstName: 'Anna',
        lastName: 'Secondary',
        email: `anna-secondary-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: 'CFO',
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: linkedUser.userId,
        removedAt: null,
      });
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await archiveMember(
      asMemberId(memberId),
      {},
      { actorUserId: user.userId, requestId: `rq-arch-dedup-${Date.now()}` },
      deps,
    );
    expect(result.ok).toBe(true);

    // Assert exactly ONE user_sessions_revoked audit for the linked user —
    // scoped to this member_id + user_id to isolate from earlier tests.
    const revokedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'user_sessions_revoked'),
        ),
      );
    const matching = revokedAudits.filter((r) => {
      const p = r.payload as { member_id?: string; user_id?: string };
      return p.member_id === memberId && p.user_id === linkedUser.userId;
    });
    expect(matching).toHaveLength(1);

    // member_archived audit payload should contain the user only once
    const archivedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_archived'),
        ),
      );
    const match = archivedAudits.find(
      (r) => (r.payload as { member_id?: string })?.member_id === memberId,
    );
    expect(match).toBeDefined();
    const payload = match!.payload as {
      cascaded_user_ids?: string[];
    };
    expect(payload.cascaded_user_ids).toEqual([linkedUser.userId]);
  });

  it('cascade: soft-consumes pending unredeemed invitations for linked users', async () => {
    const linkedUser = await createActiveTestUser('member');
    const { memberId } = await seedMember(tenant, planId, {
      linkedUserId: linkedUser.userId,
    });

    // Seed a pending invitation for the linked user (7-day window)
    const invitationId = `inv-${randomUUID().replace(/-/g, '')}`;
    await db.insert(invitations).values({
      id: invitationId,
      userId: linkedUser.userId,
      invitedByUserId: user.userId,
      intendedRole: 'member',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      consumedAt: null,
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await archiveMember(
      asMemberId(memberId),
      {},
      { actorUserId: user.userId, requestId: `rq-arch-inv-${Date.now()}` },
      deps,
    );
    expect(result.ok).toBe(true);

    // Invitation should be soft-consumed (consumedAt set)
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(rows[0]?.consumedAt).not.toBeNull();

    // Audit payload includes invitations_revoked_count ≥ 1
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_archived'),
        ),
      );
    const match = audits.find(
      (r) => (r.payload as { member_id?: string })?.member_id === memberId,
    );
    expect(match).toBeDefined();
    expect(
      (match!.payload as { invitations_revoked_count?: number })
        ?.invitations_revoked_count,
    ).toBeGreaterThanOrEqual(1);
  });

  it('cross-tenant archive returns not_found (RLS)', async () => {
    const { memberId } = await seedMember(tenant, planId);
    const otherTenant = await createTestTenant('test');
    try {
      const deps = buildMembersDeps(otherTenant.ctx);
      const result = await archiveMember(
        asMemberId(memberId),
        {},
        { actorUserId: user.userId, requestId: `rq-arch-x-${Date.now()}` },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('not_found');
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  });
});
