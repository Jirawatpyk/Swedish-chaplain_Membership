/**
 * F9 US5 (T074/T078) — directory write + search + publication integration
 * (live Neon).
 *
 * Covers the paths that open a `runInTenant` tx (so unit tests cannot):
 *   - `updateDirectoryListing` write: row upsert + atomic `directory_listing_updated`
 *     audit + changed_fields; member self-edit + admin-on-behalf; member_not_found;
 *     blank-website normalization (→ null).
 *   - `searchDirectory`: keyword across industry/description (FR-024), tier filter,
 *     listedOnly, country filter, listing-status annotation.
 *   - `listPublishedInTx` + `projectPublishedListing`: SC-007 zero-leakage — only
 *     listed + non-archived members appear, a hidden email becomes a contact-form
 *     indicator (FR-028), opted-out + archived members never leak.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  projectPublishedListing,
  searchDirectory,
  updateDirectoryListing,
  makeSearchDirectoryDeps,
  makeUpdateDirectoryListingDeps,
  type DirectoryRecord,
} from '@/modules/insights';
import { directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('F9 directory — integration (T074/T078)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-dir-${randomUUID().slice(0, 8)}`;
  const m1 = randomUUID(); // Acme — will opt-in (listed)
  const m2 = randomUUID(); // Beta — stays opted-out
  const m3 = randomUUID(); // Gamma — archived, admin sets listed (must NOT publish)

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Corporate Gold' },
        planCategory: 'corporate',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      const seedMember = (
        memberId: string,
        companyName: string,
        status: 'active' | 'inactive' | 'archived',
      ) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          companyName,
          country: 'TH',
          planId,
          planYear: 2026,
          status,
          archivedAt: status === 'archived' ? new Date() : null,
          riskScore: null,
          riskScoreBand: null,
        });
      await seedMember(m1, 'Acme Manufacturing', 'active');
      await seedMember(m2, 'Beta Services', 'active');
      await seedMember(m3, 'Gamma Archived Co', 'archived');

      const seedContact = (memberId: string, first: string, email: string) =>
        tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: first,
          lastName: 'Lastname',
          email,
          isPrimary: true,
        });
      await seedContact(m1, 'Somchai', 'somchai@acme.example');
      await seedContact(m2, 'Beatrix', 'bea@beta.example');
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(directoryListings).where(eq(directoryListings.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  const memberMeta = (memberId: string, requestId: string) =>
    ({
      actorUserId: admin.userId,
      actorRole: 'member' as const,
      actorMemberId: memberId,
      requestId,
    });

  const adminMeta = (requestId: string) =>
    ({
      actorUserId: admin.userId,
      actorRole: 'admin' as const,
      actorMemberId: null,
      requestId,
    });

  it('member opts in (own listing) → row persisted + directory_listing_updated audit', async () => {
    const requestId = `dir-${randomUUID()}`;
    const result = await updateDirectoryListing(
      {
        memberId: m1,
        listed: true,
        fieldVisibility: {
          name: true,
          tier: true,
          industry: true,
          description: true,
          website: true,
          location: true,
          contact_name: true,
          contact_email: false, // hidden → contact-form indicator (FR-028)
        },
        industry: 'Manufacturing',
        description: 'We make widgets.',
        website: 'https://acme.example',
        locationCity: 'Bangkok',
        locationCountry: 'TH',
      },
      memberMeta(m1, requestId),
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(directoryListings)
      .where(
        and(
          eq(directoryListings.tenantId, tenant.ctx.slug),
          eq(directoryListings.memberId, m1),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.listed).toBe(true);
    expect(rows[0]?.industry).toBe('Manufacturing');
    expect(rows[0]?.website).toBe('https://acme.example');

    const audit = await db.select().from(auditLog).where(eq(auditLog.requestId, requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.eventType).toBe('directory_listing_updated');
    const payload = audit[0]?.payload as {
      subject_member_id: string;
      listed: boolean;
      changed_fields: string[];
    };
    expect(payload.subject_member_id).toBe(m1);
    expect(payload.listed).toBe(true);
    expect(payload.changed_fields).toEqual(
      expect.arrayContaining(['listed', 'field_visibility', 'industry']),
    );
  });

  it('admin edits archived member on-behalf (listed=true) — allowed', async () => {
    const result = await updateDirectoryListing(
      {
        memberId: m3,
        listed: true,
        fieldVisibility: { name: true },
        industry: null,
        description: null,
        website: null,
        locationCity: null,
        locationCountry: null,
      },
      adminMeta(`dir-${randomUUID()}`),
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
  });

  it("forbids a member editing another member's listing (no row written for m2)", async () => {
    const result = await updateDirectoryListing(
      {
        memberId: m2,
        listed: true,
        fieldVisibility: { name: true },
        industry: null,
        description: null,
        website: null,
        locationCity: null,
        locationCountry: null,
      },
      memberMeta(m1, `dir-${randomUUID()}`), // m1 acting on m2
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');

    const rows = await db
      .select()
      .from(directoryListings)
      .where(
        and(
          eq(directoryListings.tenantId, tenant.ctx.slug),
          eq(directoryListings.memberId, m2),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('member_not_found for an unknown member id', async () => {
    const result = await updateDirectoryListing(
      {
        memberId: randomUUID(),
        listed: true,
        fieldVisibility: {},
        industry: null,
        description: null,
        website: null,
        locationCity: null,
        locationCountry: null,
      },
      adminMeta(`dir-${randomUUID()}`),
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('member_not_found');
  });

  it('a blank website normalizes to null (no scheme error)', async () => {
    const result = await updateDirectoryListing(
      {
        memberId: m1,
        listed: true,
        fieldVisibility: { name: true, contact_name: true, contact_email: false },
        industry: 'Manufacturing',
        description: 'We make widgets.',
        website: '   ',
        locationCity: 'Bangkok',
        locationCountry: 'TH',
      },
      memberMeta(m1, `dir-${randomUUID()}`),
      tenant.ctx,
      makeUpdateDirectoryListingDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    const rows = await db
      .select()
      .from(directoryListings)
      .where(
        and(
          eq(directoryListings.tenantId, tenant.ctx.slug),
          eq(directoryListings.memberId, m1),
        ),
      );
    expect(rows[0]?.website).toBeNull();
  });

  describe('searchDirectory (FR-024)', () => {
    const deps = () => makeSearchDirectoryDeps(tenant.ctx.slug);
    const meta = () => adminMeta('search');

    it('lists non-archived members with listing status (archived excluded)', async () => {
      const result = await searchDirectory({}, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.items.map((i) => i.memberId);
      expect(ids).toContain(m1);
      expect(ids).toContain(m2);
      expect(ids).not.toContain(m3); // archived excluded
      const acme = result.value.items.find((i) => i.memberId === m1)!;
      const beta = result.value.items.find((i) => i.memberId === m2)!;
      expect(acme.listed).toBe(true);
      expect(acme.contactName).toBe('Somchai Lastname');
      expect(beta.listed).toBe(false); // no listing row → not listed
    });

    it('keyword matches the listing description (FR-024)', async () => {
      const result = await searchDirectory({ q: 'widgets' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((i) => i.memberId)).toEqual([m1]);
    });

    it('keyword matches the listing industry (FR-024)', async () => {
      const result = await searchDirectory({ q: 'Manufactur' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((i) => i.memberId)).toEqual([m1]);
    });

    it('keyword matches the member COMPANY NAME, incl. a member with no listing row (AS-1 / Gap A)', async () => {
      // m2 (Beta Services) has NO directory_listings row — proves the company-name
      // OR-branch works independently of the LEFT-joined dl.* columns. A regression
      // dropping `m.company_name ILIKE` would make this return [] and fail.
      const result = await searchDirectory({ q: 'Beta' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((i) => i.memberId)).toEqual([m2]);

      const acme = await searchDirectory({ q: 'Acme' }, meta(), tenant.ctx, deps());
      expect(acme.ok).toBe(true);
      if (acme.ok) expect(acme.value.items.map((i) => i.memberId)).toEqual([m1]);
    });

    it('LIKE metacharacters in the keyword are escaped, not treated as wildcards (Gap B)', async () => {
      // No seeded member contains a literal "%". Without escaping, q='%' becomes
      // the SQL wildcard `%%` and matches EVERY member; with escaping it matches
      // only a literal "%" → none. Asserts the escape in `likeTerm`.
      const result = await searchDirectory({ q: '%' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items).toHaveLength(0);
    });

    it('tier filter matches plan_category', async () => {
      const result = await searchDirectory({ tier: 'corporate' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // both active members are on the corporate plan; archived excluded
      expect(result.value.items.map((i) => i.memberId).sort()).toEqual([m1, m2].sort());
    });

    it('listedOnly returns only opted-in members', async () => {
      const result = await searchDirectory({ listedOnly: true }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.items.map((i) => i.memberId)).toEqual([m1]);
    });

    it('country filter matches the listing location_country', async () => {
      const result = await searchDirectory({ country: 'TH' }, meta(), tenant.ctx, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // only m1 has a listing with location_country=TH; m2 has no listing row
      expect(result.value.items.map((i) => i.memberId)).toEqual([m1]);
    });

    it('a member is forbidden from the staff directory', async () => {
      const result = await searchDirectory(
        {},
        { ...meta(), actorRole: 'member' },
        tenant.ctx,
        deps(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('forbidden');
    });
  });

  describe('listPublishedInTx + projectPublishedListing (SC-007 zero-leakage)', () => {
    it('publishes only listed non-archived members; hides email behind a contact form', async () => {
      // Set m1's listing to a known full state (prior tests mutate it) so this
      // assertion is order-independent: industry visible, contact email hidden.
      await updateDirectoryListing(
        {
          memberId: m1,
          listed: true,
          fieldVisibility: {
            name: true,
            industry: true,
            contact_name: true,
            contact_email: false,
          },
          industry: 'Manufacturing',
          description: 'We make widgets.',
          website: 'https://acme.example',
          locationCity: 'Bangkok',
          locationCountry: 'TH',
        },
        memberMeta(m1, `dir-${randomUUID()}`),
        tenant.ctx,
        makeUpdateDirectoryListingDeps(tenant.ctx.slug),
      );

      const repo = makeSearchDirectoryDeps(tenant.ctx.slug).directoryRepo;
      const published = await runInTenant(tenant.ctx, (tx) => repo.listPublishedInTx(tx));

      // m1 listed → present; m2 opted-out → absent; m3 archived → absent (SC-007).
      const ids = published.map((p) => p.memberId);
      expect(ids).toContain(m1);
      expect(ids).not.toContain(m2);
      expect(ids).not.toContain(m3);

      const acme = published.find((p) => p.memberId === m1)!;
      const record: DirectoryRecord = {
        listed: true,
        fieldVisibility: acme.listing.fieldVisibility,
        identity: {
          memberName: acme.companyName,
          tier: acme.tier,
          contactName: acme.contactName,
          contactEmail: acme.contactEmail,
        },
        metadata: {
          industry: acme.listing.industry,
          description: acme.listing.description,
          website: acme.listing.website,
          logoUrl: acme.listing.logoBlobKey,
          locationCity: acme.listing.locationCity,
          locationCountry: acme.listing.locationCountry,
        },
      };
      const out = projectPublishedListing(record)!;
      expect(out.name).toBe('Acme Manufacturing');
      expect(out.industry).toBe('Manufacturing');
      // contact_email was toggled hidden → email omitted, contact-form indicator set.
      expect(out.contact).toEqual({ name: 'Somchai Lastname', contactForm: true });
      expect(out.contact).not.toHaveProperty('email');
    });

    it('opt-out after listing: a new export immediately excludes the member (FR-028 edge — point-in-time snapshot)', async () => {
      const repo = makeSearchDirectoryDeps(tenant.ctx.slug).directoryRepo;
      // m1 is currently listed (from the prior test) → present in a fresh export.
      const before = await runInTenant(tenant.ctx, (tx) => repo.listPublishedInTx(tx));
      expect(before.map((p) => p.memberId)).toContain(m1);

      // Member opts out.
      const optOut = await updateDirectoryListing(
        {
          memberId: m1,
          listed: false,
          fieldVisibility: { name: true },
          industry: 'Manufacturing',
          description: 'We make widgets.',
          website: null,
          locationCity: 'Bangkok',
          locationCountry: 'TH',
        },
        memberMeta(m1, `dir-optout-${randomUUID()}`),
        tenant.ctx,
        makeUpdateDirectoryListingDeps(tenant.ctx.slug),
      );
      expect(optOut.ok).toBe(true);

      // A NEW export reflects the current opt-out (a previously generated
      // artefact is a point-in-time snapshot; the source query is not).
      const after = await runInTenant(tenant.ctx, (tx) => repo.listPublishedInTx(tx));
      expect(after.map((p) => p.memberId)).not.toContain(m1);
    });
  });
});
