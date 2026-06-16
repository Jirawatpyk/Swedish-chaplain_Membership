/**
 * COMP-1 US1 (Member Erasure, Task 9) — Integration: end-to-end `eraseMember`
 * PII oracle + sentinel-email collision, against live Neon.
 *
 * This is the BROADER oracle (design §10) over the per-repo scrub tests
 * (`member-scrub.test.ts` / `contact-scrub.test.ts`) and the cascade-ordering
 * test (`erase-member-cascade.test.ts`): it drives the WHOLE use case through
 * the PRODUCTION composition root `buildEraseMemberDeps(tenant)` — the same
 * builder the erase route wires, with the REAL F7/F8 cascade adapters — on a
 * freshly-seeded member that has NO in-flight broadcasts/renewals. For such a
 * member the real cascades return `outcome: 'ok'`, so `member_erased` is
 * emitted and `result.value.cascadesComplete === true`.
 *
 * Asserts via BYPASSRLS raw selects (design §5 matrix rows for members +
 * contacts) that:
 *   - the members row is anonymised in place (company_name → '[erased]',
 *     all PII incl. business quasi-identifiers NULL, erased_at set; identity
 *     member_number/plan_id/status preserved);
 *   - BOTH contacts carry sentinels (first_name '[erased]', per-row
 *     erased+<id>@erased.invalid email, phone/DoB NULL, removed_at set);
 *   - the durable `member_erasure_requested` + the completion `member_erased`
 *     audit rows both exist; and crucially NONE of the seeded PII tokens
 *     (the 'Volvo' company token, the tax_id, a contact email) leak into ANY
 *     erasure audit payload (proves erasure audits carry no PII — §3/§6).
 *
 * The sentinel-email collision test seeds TWO members (one contact each),
 * erases both, and asserts neither `eraseMember` hits a unique-index
 * violation — proving the `removed_at` + per-row-sentinel design lets two
 * erased-contact rows coexist (design §5 contacts row + §10 collision oracle).
 *
 * Reuses the live-Neon harness shared by `erase-member-cascade.test.ts` /
 * `member-scrub.test.ts` (tenant + fee/plan seed + BYPASSRLS raw select +
 * `nextSeedMemberNumber`). No mocks — the production builder is the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-oracle-plan';

/** Distinctive PII tokens we later assert NEVER appear in any audit payload. */
const COMPANY_TOKEN = 'Volvo';
const TAX_ID = '0105536000077';
const CONTACT_EMAIL_PREFIX = 'erik-oracle';

async function seedPlan(tenant: TestTenant, userId: string) {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenant.ctx.slug,
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
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Erase Oracle Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      createdBy: userId,
      updatedBy: userId,
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

/** Seed a member with rich PII + N contacts (also rich PII). */
async function seedMemberWithContacts(
  tenant: TestTenant,
  opts: {
    companyName: string;
    taxId: string;
    contactCount: number;
    emailPrefix: string;
  },
): Promise<{ memberId: string; contactIds: string[]; contactEmails: string[] }> {
  const memberId = randomUUID();
  const contactIds: string[] = [];
  const contactEmails: string[] = [];
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: opts.companyName,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: opts.taxId,
      website: 'https://volvo.example',
      description: 'Heavy vehicles',
      notes: 'VIP — board contact',
      foundedYear: 1995,
      turnoverThb: 250_000_000,
      addressLine1: '99 Rama IV Rd',
      addressLine2: 'Floor 12',
      city: 'Bangkok',
      province: 'Bangkok',
      postalCode: '10500',
      preferredLocale: 'sv',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    for (let i = 0; i < opts.contactCount; i += 1) {
      const contactId = randomUUID();
      const email = `${opts.emailPrefix}-${randomUUID().slice(0, 8)}@example.com`;
      contactIds.push(contactId);
      contactEmails.push(email);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: i === 0 ? 'Erik' : 'Anna',
        lastName: 'Eriksson',
        email,
        phone: '+66812345678',
        roleTitle: i === 0 ? 'CEO' : 'CFO',
        preferredLanguage: 'sv',
        isPrimary: i === 0,
        dateOfBirth: '1980-01-01',
        removedAt: null,
      });
    }
  });
  return { memberId, contactIds, contactEmails };
}

async function rawSelectMember(memberId: string) {
  const rows = await db
    .select({
      member_id: members.memberId,
      member_number: members.memberNumber,
      plan_id: members.planId,
      status: members.status,
      company_name: members.companyName,
      legal_entity_type: members.legalEntityType,
      tax_id: members.taxId,
      website: members.website,
      description: members.description,
      notes: members.notes,
      founded_year: members.foundedYear,
      turnover_thb: members.turnoverThb,
      address_line1: members.addressLine1,
      address_line2: members.addressLine2,
      city: members.city,
      province: members.province,
      postal_code: members.postalCode,
      erased_at: members.erasedAt,
    })
    .from(members)
    .where(eq(members.memberId, memberId))
    .limit(1);
  return rows[0];
}

async function rawSelectContacts(memberId: string) {
  return db
    .select({
      contact_id: contacts.contactId,
      first_name: contacts.firstName,
      last_name: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      role_title: contacts.roleTitle,
      date_of_birth: contacts.dateOfBirth,
      removed_at: contacts.removedAt,
    })
    .from(contacts)
    .where(eq(contacts.memberId, memberId));
}

/** All audit rows for this tenant whose payload.member_id matches. */
async function rawSelectMemberAudits(tenantSlug: string, memberId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  return rows.filter((r) => {
    const p = r.payload as { member_id?: string } | null;
    return p?.member_id === memberId;
  });
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — live-Neon PII oracle (production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('anonymises member + both contacts, emits requested+erased audits with NO PII, completes', async () => {
    const { memberId, contactIds, contactEmails } = await seedMemberWithContacts(
      tenant,
      {
        companyName: `${COMPANY_TOKEN} Trucks (Thailand) Ltd.`,
        taxId: TAX_ID,
        contactCount: 2,
        emailPrefix: CONTACT_EMAIL_PREFIX,
      },
    );
    expect(contactIds).toHaveLength(2);

    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-oracle-${Date.now()}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // Production deps → real F7/F8 cascades return ok for a no-in-flight
    // member → member_erased emitted → cascadesComplete true.
    expect(result.value.cascadesComplete).toBe(true);

    // --- members row oracle (design §5 members row) ---
    const m = (await rawSelectMember(memberId))!;
    expect(m.company_name).toBe('[erased]');
    expect(m.tax_id).toBeNull();
    expect(m.website).toBeNull();
    expect(m.description).toBeNull();
    expect(m.notes).toBeNull();
    expect(m.founded_year).toBeNull();
    expect(m.turnover_thb).toBeNull();
    expect(m.address_line1).toBeNull();
    expect(m.address_line2).toBeNull();
    expect(m.city).toBeNull();
    expect(m.province).toBeNull();
    expect(m.postal_code).toBeNull();
    expect(m.legal_entity_type).toBeNull();
    expect(m.erased_at).not.toBeNull();
    // Identity preserved.
    expect(m.member_id).toBe(memberId);
    expect(m.member_number).toBeGreaterThan(0);
    expect(m.plan_id).toBe(PLAN_ID);
    expect(m.status).toBe('active');

    // --- both contacts oracle (design §5 contacts row) ---
    const cs = await rawSelectContacts(memberId);
    expect(cs).toHaveLength(2);
    for (const c of cs) {
      expect(c.first_name).toBe('[erased]');
      expect(c.last_name).toBe('[erased]');
      expect(c.email).toMatch(/^erased\+.*@erased\.invalid$/);
      expect(c.phone).toBeNull();
      expect(c.role_title).toBeNull();
      expect(c.date_of_birth).toBeNull();
      expect(c.removed_at).not.toBeNull();
    }

    // --- audit oracle: requested + erased both present ---
    const audits = await rawSelectMemberAudits(tenant.ctx.slug, memberId);
    const types = audits.map((a) => a.eventType);
    expect(types).toContain('member_erasure_requested');
    expect(types).toContain('member_erased');

    // --- audit oracle: NO seeded PII token leaks into any payload ---
    // (proves erasure audit payloads carry only opaque ids + reason + counts.)
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(COMPANY_TOKEN);
    expect(auditJson).not.toContain(TAX_ID);
    for (const email of contactEmails) {
      expect(auditJson).not.toContain(email);
    }
  }, 30_000);
});

describe('eraseMember — sentinel-email collision (production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('erases two members (one contact each) with no unique-index violation', async () => {
    const a = await seedMemberWithContacts(tenant, {
      companyName: 'Collision Co A',
      taxId: '0105536000088',
      contactCount: 1,
      emailPrefix: 'collide-a',
    });
    const b = await seedMemberWithContacts(tenant, {
      companyName: 'Collision Co B',
      taxId: '0105536000099',
      contactCount: 1,
      emailPrefix: 'collide-b',
    });

    const deps = buildEraseMemberDeps(tenant.ctx);

    const resA = await eraseMember(
      asMemberId(a.memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-collide-a-${Date.now()}` },
      deps,
    );
    expect(resA.ok, JSON.stringify(resA)).toBe(true);

    const resB = await eraseMember(
      asMemberId(b.memberId) as MemberId,
      { reason: 'pdpa_deletion_request' },
      { actorUserId: admin.userId, requestId: `rq-collide-b-${Date.now()}` },
      deps,
    );
    // The key assertion: B does NOT hit a unique-index violation on the
    // sentinel email — the per-row `erased+<contactId>@erased.invalid` +
    // `removed_at` design lets two erased contacts coexist.
    expect(resB.ok, JSON.stringify(resB)).toBe(true);

    // Sanity: both contacts scrubbed to distinct sentinels.
    const csA = await rawSelectContacts(a.memberId);
    const csB = await rawSelectContacts(b.memberId);
    expect(csA[0]?.email).toMatch(/^erased\+.*@erased\.invalid$/);
    expect(csB[0]?.email).toMatch(/^erased\+.*@erased\.invalid$/);
    expect(csA[0]?.email).not.toBe(csB[0]?.email);
  }, 30_000);
});
