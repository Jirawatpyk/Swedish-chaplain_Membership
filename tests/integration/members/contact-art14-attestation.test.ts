/**
 * Task 8 — GDPR Art. 14 attestation: live-Neon end-to-end coverage.
 *
 * A secondary contact / an Edit-page "Add contact" is a named third party
 * whose data an ADMIN supplies, never the person themselves. GDPR Art. 14
 * requires notice within a month (Thailand PDPA §25: within 30 days, with no
 * "already has the information" exception at all).
 *
 * The product decision (2026-07-14) is that the admin informs the person
 * DIRECTLY and ATTESTS to having done so at the moment of collection. Note
 * what that is and is not — corrected 2026-07-15 after a compliance review,
 * because the first version of this comment cited the wrong article: it is NOT
 * the Art. 14(5)(a) exemption (which covers a subject who already has the
 * particulars independently of us). It is the Art. 14(1)-(2) notice duty
 * DISCHARGED OUT-OF-BAND — GDPR mandates no particular channel — with the
 * persisted timestamp serving as Art. 5(2) accountability evidence. This suite
 * proves the
 * attestation is a persisted DB fact (`contacts.art14_attested_at`), not
 * just a UI gesture, across BOTH entry points:
 *
 *   1. `addContact` (contact-crud.ts) — the Edit page's "Add contact" flow.
 *   2. `scrubPiiForMemberInTx` — the erasure path PRESERVES the attestation
 *      timestamp (it is compliance evidence, not PII) rather than nulling
 *      it — the "erosion trap" the task brief flagged (no coverage guard
 *      exists for `contacts` erasure columns other than
 *      `scrub-contacts-pii-column-coverage.test.ts`, which this suite
 *      complements with a real end-to-end round-trip).
 *
 * `createMember`'s primary-vs-secondary split is covered in
 * `create-member.test.ts` (the "creates a secondary contact alongside the
 * primary" test asserts both `art14AttestedAt` values). Schema-level
 * rejection cases (missing/false/non-boolean `art14_attested`) are unit
 * tests in `contact-crud-art14-attestation.test.ts` — this suite only
 * covers what requires a real Postgres round-trip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { MemberId } from '@/modules/members';
import { addContact } from '@/modules/members/application/use-cases/contact-crud';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('Task 8 — GDPR Art. 14 attestation (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = 'test-art14-plan';

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
        planId,
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
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin);
  });

  async function seedMemberWithPrimaryContact(): Promise<string> {
    const memberId = randomUUID();
    const rand = randomUUID().slice(0, 8);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Art14 Co ${rand}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Primary',
        lastName: 'Contact',
        email: `primary-${rand}@example.com`,
        preferredLanguage: 'en',
        isPrimary: true,
      });
    });
    return memberId;
  }

  it('addContact rejects a body missing art14_attested — no row is created', async () => {
    const memberId = await seedMemberWithPrimaryContact();
    const deps = buildMembersDeps(tenant.ctx);
    const email = `no-attest-${randomUUID().slice(0, 8)}@example.com`;

    const result = await addContact(
      memberId as MemberId,
      {
        first_name: 'Rejected',
        last_name: 'Contact',
        email,
        preferred_language: 'en',
        // art14_attested deliberately omitted
      },
      { actorUserId: admin.userId, requestId: `rq-${Date.now()}-no-attest` },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, email)),
    );
    expect(rows).toHaveLength(0);
  }, 30_000);

  it('addContact with art14_attested:true persists a real art14_attested_at timestamp', async () => {
    const memberId = await seedMemberWithPrimaryContact();
    const deps = buildMembersDeps(tenant.ctx);
    const email = `attested-${randomUUID().slice(0, 8)}@example.com`;
    const before = Date.now();

    const result = await addContact(
      memberId as MemberId,
      {
        first_name: 'Attested',
        last_name: 'Contact',
        email,
        preferred_language: 'en',
        art14_attested: true,
      },
      { actorUserId: admin.userId, requestId: `rq-${Date.now()}-attest` },
      deps,
    );
    const after = Date.now();

    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Direct query — proves the column exists AND holds the right value,
    // not just that the use case reported ok.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, email)),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isPrimary).toBe(false);
    expect(row.art14AttestedAt).not.toBeNull();
    expect(row.art14AttestedAt).toBeInstanceOf(Date);
    const ts = row.art14AttestedAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  }, 30_000);

  it('scrubPiiForMemberInTx PRESERVES art14_attested_at across erasure (compliance evidence, not PII)', async () => {
    const memberId = randomUUID();
    const contactId = randomUUID();
    const rand = randomUUID().slice(0, 8);
    const attestedAt = new Date('2026-06-01T12:00:00.000Z');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Art14 Scrub Co ${rand}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'ToBeErased',
        lastName: 'Secondary',
        email: `erase-${rand}@example.com`,
        preferredLanguage: 'en',
        isPrimary: false,
        art14AttestedAt: attestedAt,
      });
    });

    const erasedAt = new Date('2026-07-14T00:00:00.000Z');
    const result = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.scrubPiiForMemberInTx(tx, memberId as MemberId, {
        erasedAt,
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Owner-role read (bypasses RLS) mirrors contact-scrub.test.ts's
    // rawSelectContacts pattern — the scrubbed row's identity columns are
    // sentinels, but art14_attested_at must survive untouched.
    const rows = await db
      .select({
        firstName: contacts.firstName,
        email: contacts.email,
        removedAt: contacts.removedAt,
        art14AttestedAt: contacts.art14AttestedAt,
      })
      .from(contacts)
      .where(eq(contacts.memberId, memberId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Sanity: this IS the scrub having run (identity sentinel-ized).
    expect(row.firstName).toBe('[erased]');
    expect(row.removedAt).not.toBeNull();
    // The load-bearing assertion — the Art. 14 evidence survives erasure.
    expect(row.art14AttestedAt).not.toBeNull();
    expect(row.art14AttestedAt!.toISOString()).toBe(attestedAt.toISOString());
  }, 30_000);
});
