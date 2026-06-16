/**
 * COMP-1 US1 (Member Erasure, Task 2) — Integration: contacts sentinel-scrub.
 *
 * Exercises `ContactRepo.scrubPiiForMemberInTx` against live Neon with a
 * seeded tenant + member + contact. The contacts identity columns
 * `first_name`/`last_name`/`email` are NOT NULL, so they are replaced with
 * non-PII SENTINELS rather than NULL; the per-row email sentinel embeds the
 * `contact_id` so two erased members cannot collide on the
 * `contacts_tenant_email_uniq` partial index. `phone`/`date_of_birth`/
 * `role_title` → NULL. `removed_at` is set (so the row leaves the
 * `lower(email) WHERE removed_at IS NULL` partial unique index) and
 * `is_primary` is forced FALSE.
 *
 * Reuses the live-Neon harness shared by `contact-email-change-atomic.test.ts`
 * (`.env.local` → DATABASE_URL). No mocks — the whole point is that the
 * UPDATE + per-row sql sentinel hold end-to-end against real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { MemberId } from '@/modules/members';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

interface SeededContact {
  memberId: string;
  contactId: string;
}

async function seedMemberWithContact(
  tenant: TestTenant,
  fields: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    roleTitle: string;
    dateOfBirth: string;
  },
): Promise<SeededContact> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  const rand = randomUUID().slice(0, 8);

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Scrub Co ${rand}`,
      country: 'TH',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: fields.firstName,
      lastName: fields.lastName,
      email: fields.email,
      phone: fields.phone,
      roleTitle: fields.roleTitle,
      dateOfBirth: fields.dateOfBirth,
      preferredLanguage: 'sv',
      isPrimary: true,
    });
  });

  return { memberId, contactId };
}

/** Raw select via the BYPASSRLS owner role so the assertion sees the row. */
async function rawSelectContacts(memberId: string) {
  return db
    .select({
      first_name: contacts.firstName,
      last_name: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      date_of_birth: contacts.dateOfBirth,
      role_title: contacts.roleTitle,
      removed_at: contacts.removedAt,
      is_primary: contacts.isPrimary,
    })
    .from(contacts)
    .where(eq(contacts.memberId, memberId));
}

// ---- Test suite ------------------------------------------------------------

describe('ContactRepo.scrubPiiForMemberInTx', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed fee config + plan so the members FK `(tenant_id, plan_id,
    // plan_year) → membership_plans` is satisfied.
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
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it('replaces NOT NULL identity columns with sentinels, NULLs the rest, sets removed_at', async () => {
    const { memberId, contactId } = await seedMemberWithContact(tenant, {
      firstName: 'Anders',
      lastName: 'Svensson',
      email: 'anders@example.com',
      phone: '+66812345678',
      roleTitle: 'CEO',
      dateOfBirth: '1980-01-01',
    });
    const erasedAt = new Date('2026-06-16T00:00:00.000Z');

    const result = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.scrubPiiForMemberInTx(tx, memberId as MemberId, {
        erasedAt,
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.value.scrubbedCount).toBe(1);
    }

    const rows = await rawSelectContacts(memberId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.first_name).toBe('[erased]');
    expect(row.last_name).toBe('[erased]');
    expect(row.email).toBe(`erased+${contactId}@erased.invalid`);
    expect(row.phone).toBeNull();
    expect(row.date_of_birth).toBeNull();
    expect(row.role_title).toBeNull();
    expect(row.removed_at).not.toBeNull();
    expect(row.is_primary).toBe(false);
  }, 30_000);
});
