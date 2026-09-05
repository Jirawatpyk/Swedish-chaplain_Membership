/**
 * 108 T041 review round 1 (security-engineer, H1) — Constitution Principle I
 * §iii: every new tenant-scoped repo method ships with a cross-tenant
 * live-Neon test. PR-B added `listByMemberInTx` and `designatePrimaryInTx`
 * (both RLS-scoped, no explicit tenant filter by convention) and wired them
 * through `undeleteMember`'s FR-014 designation. The mock-level tests cannot
 * prove RLS; this file does, through the real use case against the dev branch.
 *
 *   (a) tenant B cannot restore tenant A's member — `not_found`, no writes;
 *   (b) tenant A naming tenant B's contact as the designation is refused with
 *       A's OWN list only (no cross-tenant enumeration oracle);
 *   (c) the happy path through the use case writes the designation, the
 *       `member_primary_contact_changed` audit row with an honest null
 *       predecessor, and the restore — in one commit.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { undeleteMember, type ContactId, type MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('108 — undelete designation is tenant-isolated (Principle I §iii)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  async function seedTenantBasics(t: TestTenant, suffix: string): Promise<void> {
    await runInTenant(t.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: t.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: `Iso TH ${suffix}`,
        legalNameEn: `Iso EN ${suffix}`,
        taxId: '0000000000000',
        registeredAddressTh: 'Iso Address TH',
        registeredAddressEn: 'Iso Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: t.ctx.slug,
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
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
        },
      });
    });
  }

  /** An ARCHIVED member with two live secondaries and no primary. */
  async function seedArchivedNoPrimary(
    t: TestTenant,
  ): Promise<{ memberId: MemberId; contactIds: ContactId[] }> {
    const memberId = randomUUID() as MemberId;
    const contactIds = [randomUUID() as ContactId, randomUUID() as ContactId];
    const rand = randomUUID().slice(0, 8);
    await runInTenant(t.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Iso Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date(Date.now() - 5 * 86_400_000),
      });
      await tx.insert(contacts).values(
        contactIds.map((contactId, i) => ({
          tenantId: t.ctx.slug,
          contactId,
          memberId,
          firstName: 'Iso',
          lastName: `${i}`,
          email: `iso-${i}-${rand}@example.com`,
          preferredLanguage: 'en' as const,
          isPrimary: false,
        })),
      );
    });
    return { memberId, contactIds };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seedTenantBasics(tenantA, 'A');
    await seedTenantBasics(tenantB, 'B');
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
    await deleteTestUser(admin);
  });

  it('(a) tenant B cannot restore tenant A\'s member — not_found, nothing written', async () => {
    const a = await seedArchivedNoPrimary(tenantA);

    const result = await undeleteMember(
      a.memberId,
      { actorUserId: admin.userId, requestId: `iso-a-${randomUUID().slice(0, 8)}` },
      buildMembersDeps(tenantB.ctx),
      { designatePrimaryContactId: a.contactIds[0]! },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('not_found');
    const [row] = await db
      .select({ status: members.status })
      .from(members)
      .where(and(eq(members.tenantId, tenantA.ctx.slug), eq(members.memberId, a.memberId)));
    expect(row?.status).toBe('archived');
    const primaries = await db
      .select({ id: contacts.contactId })
      .from(contacts)
      .where(and(eq(contacts.memberId, a.memberId), eq(contacts.isPrimary, true)));
    expect(primaries).toHaveLength(0);
  });

  it('(b) naming another tenant\'s contact is refused with the caller\'s OWN list only', async () => {
    const a = await seedArchivedNoPrimary(tenantA);
    const b = await seedArchivedNoPrimary(tenantB);

    const result = await undeleteMember(
      a.memberId,
      { actorUserId: admin.userId, requestId: `iso-b-${randomUUID().slice(0, 8)}` },
      buildMembersDeps(tenantA.ctx),
      { designatePrimaryContactId: b.contactIds[0]! },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('state_error');
    if (result.error.type !== 'state_error') return;
    expect(result.error.code).toBe('no_primary_contact');
    const offered = (result.error.designatable ?? []).map((c) => c.contactId).sort();
    expect(offered).toEqual([...a.contactIds].sort());
    // Indistinguishable from "no contact named": nothing about B leaks, and
    // B's contact is untouched.
    for (const id of b.contactIds) {
      const [row] = await db
        .select({ isPrimary: contacts.isPrimary })
        .from(contacts)
        .where(eq(contacts.contactId, id));
      expect(row?.isPrimary).toBe(false);
    }
  });

  it('(c) happy path: designation + restore + audit commit together, predecessor honestly null', async () => {
    const a = await seedArchivedNoPrimary(tenantA);
    const requestId = `iso-c-${randomUUID().slice(0, 8)}`;

    const result = await undeleteMember(
      a.memberId,
      { actorUserId: admin.userId, requestId },
      buildMembersDeps(tenantA.ctx),
      { designatePrimaryContactId: a.contactIds[1]! },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.member.status).toBe('active');
    expect(result.value.designatedContactId).toBe(a.contactIds[1]);

    const rows = await db
      .select({ id: contacts.contactId, isPrimary: contacts.isPrimary })
      .from(contacts)
      .where(and(eq(contacts.memberId, a.memberId), sql`${contacts.removedAt} IS NULL`));
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([a.contactIds[1]]);

    const audits = await db
      .select({ type: auditLog.eventType, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), eq(auditLog.requestId, requestId)));
    const changed = audits.find((r) => r.type === 'member_primary_contact_changed');
    expect(changed).toBeDefined();
    expect(changed?.payload).toMatchObject({
      member_id: a.memberId,
      old_primary_contact_id: null,
      new_primary_contact_id: a.contactIds[1],
    });
    expect(audits.some((r) => r.type === 'member_undeleted')).toBe(true);
  });
});
