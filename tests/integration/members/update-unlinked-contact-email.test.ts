/**
 * Integration: `updateUnlinkedContactEmail` against live Neon.
 *
 * Imported members (never invited to the portal) have contacts with
 * `linked_user_id = NULL`. Their email is a plain contact field, NOT a
 * login identity, so it is updated in place — the FR-012a atomic flow
 * (session revoke + dual-channel verify/revert) is only needed when the
 * address is also a portal login. This closes the gap where the route
 * previously rejected such edits with 409 `not_supported` (contradicting
 * its own header comment).
 *
 * Verifies:
 *   - happy: email written in place + exactly one `contact_updated` audit row
 *   - conflict: colliding with another ACTIVE contact email → `conflict`
 *   - not_found: wrong member (IDOR guard) → `not_found`, no write
 *   - invalid_email: malformed address → `invalid_email`, no write
 *   - defense: a LINKED contact is REFUSED (never a silent in-place write —
 *     that would bypass session revocation + verification)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  updateUnlinkedContactEmail,
  type ContactId,
  type MemberId,
} from '@/modules/members';
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

const r = () => randomUUID().slice(0, 8);

async function seedMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Unlinked Co ${r()}`,
      country: 'TH',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
    });
  });
  return memberId;
}

async function seedContact(
  tenant: TestTenant,
  memberId: string,
  opts: { email: string; isPrimary?: boolean; linkedUserId?: string | null },
): Promise<ContactId> {
  const contactId = randomUUID() as ContactId;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Con',
      lastName: 'Tact',
      email: opts.email,
      preferredLanguage: 'en',
      isPrimary: opts.isPrimary ?? false,
      linkedUserId: opts.linkedUserId ?? null,
    }),
  );
  return contactId;
}

async function readEmail(
  tenant: TestTenant,
  contactId: ContactId,
): Promise<string | undefined> {
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ email: contacts.email })
      .from(contacts)
      .where(eq(contacts.contactId, contactId))
      .limit(1),
  );
  return row?.email;
}

async function countContactUpdatedAudit(slug: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenantId, slug), eq(auditLog.eventType, 'contact_updated')),
    );
  return row?.n ?? 0;
}

describe('updateUnlinkedContactEmail (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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

  function meta() {
    return { actorUserId: admin.userId, requestId: `req-${r()}` };
  }

  it('updates an unlinked contact email in place + records one contact_updated audit', async () => {
    const memberId = await seedMember(tenant);
    const contactId = await seedContact(tenant, memberId, {
      email: `old-${r()}@example.com`,
      isPrimary: true,
    });
    const newEmail = `new-${r()}@example.com`;
    const deps = buildMembersDeps(tenant.ctx);
    const auditBefore = await countContactUpdatedAudit(tenant.ctx.slug);

    const result = await updateUnlinkedContactEmail(
      memberId as MemberId,
      contactId,
      newEmail,
      meta(),
      { ...deps, tenant: tenant.ctx },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.email).toBe(newEmail);
    expect(await readEmail(tenant, contactId)).toBe(newEmail);
    expect((await countContactUpdatedAudit(tenant.ctx.slug)) - auditBefore).toBe(1);
  });

  it('rejects with conflict when the new email is already an active contact email', async () => {
    const memberId = await seedMember(tenant);
    const primary = await seedContact(tenant, memberId, {
      email: `p-${r()}@example.com`,
      isPrimary: true,
    });
    const takenEmail = `taken-${r()}@example.com`;
    await seedContact(tenant, memberId, { email: takenEmail, isPrimary: false });
    const deps = buildMembersDeps(tenant.ctx);

    const result = await updateUnlinkedContactEmail(
      memberId as MemberId,
      primary,
      takenEmail,
      meta(),
      { ...deps, tenant: tenant.ctx },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('conflict');
  });

  it('returns not_found when the contact does not belong to the member (IDOR guard)', async () => {
    const memberId = await seedMember(tenant);
    const contactId = await seedContact(tenant, memberId, {
      email: `own-${r()}@example.com`,
      isPrimary: true,
    });
    const deps = buildMembersDeps(tenant.ctx);

    const result = await updateUnlinkedContactEmail(
      randomUUID() as MemberId, // not the owner
      contactId,
      `new-${r()}@example.com`,
      meta(),
      { ...deps, tenant: tenant.ctx },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    // unchanged
    expect(await readEmail(tenant, contactId)).toContain('own-');
  });

  it('returns invalid_email for a malformed address (no write)', async () => {
    const memberId = await seedMember(tenant);
    const original = `keep-${r()}@example.com`;
    const contactId = await seedContact(tenant, memberId, {
      email: original,
      isPrimary: true,
    });
    const deps = buildMembersDeps(tenant.ctx);

    const result = await updateUnlinkedContactEmail(
      memberId as MemberId,
      contactId,
      'not-an-email',
      meta(),
      { ...deps, tenant: tenant.ctx },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_email');
    expect(await readEmail(tenant, contactId)).toBe(original);
  });

  it('REFUSES a linked contact — never a silent in-place write (must use the atomic flow)', async () => {
    const linkedUser = await createActiveTestUser('member');
    const memberId = await seedMember(tenant);
    const contactId = await seedContact(tenant, memberId, {
      email: linkedUser.rawEmail,
      isPrimary: true,
      linkedUserId: linkedUser.userId,
    });
    const deps = buildMembersDeps(tenant.ctx);

    const result = await updateUnlinkedContactEmail(
      memberId as MemberId,
      contactId,
      `new-${r()}@example.com`,
      meta(),
      { ...deps, tenant: tenant.ctx },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // email left untouched — the atomic FR-012a flow was NOT bypassed
    expect(await readEmail(tenant, contactId)).toBe(linkedUser.rawEmail);

    await deleteTestUser(linkedUser);
  });
});
