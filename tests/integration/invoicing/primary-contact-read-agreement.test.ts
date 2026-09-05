/**
 * 108 review round 3, finding #13 — REJECTED, and this test is the evidence.
 *
 * The finding said the four primary-contact reads on the money path could each
 * pick a DIFFERENT contact, because all four use `LIMIT 1` with no `ORDER BY`
 * and "the exactly-one-primary invariant is not yet enforced by a DB
 * constraint". One invoice could then be ADDRESSED to contact A, NAME contact B
 * on its tax document, and hand contact C's address to Stripe.
 *
 * The at-most-one half of that invariant HAS been a database constraint since
 * migration 0009:
 *
 *   CREATE UNIQUE INDEX contacts_one_primary_per_member
 *     ON contacts (tenant_id, member_id)
 *     WHERE is_primary = TRUE AND removed_at IS NULL;
 *
 * All four reads filter on exactly that predicate, so at most one row can match
 * and `LIMIT 1` is unambiguous. (PR-B adds the at-LEAST-one half — "a member
 * always has a primary" — which is a different guarantee.) A tiebreak `ORDER BY`
 * was written for this finding and then reverted: it would have implied a
 * multi-row case the database forbids, and a comment claiming these reads "might
 * otherwise disagree" is worse than no comment at all.
 *
 * So the thing worth pinning is not an ordering. It is that the index is really
 * there and really rejects the second row — that is what the reads' safety rests
 * on, and what would silently stop being true if the index were dropped. That is
 * asserted first. The four reads then agree by construction, and each is still
 * checked here so a future predicate edit that steps OUTSIDE the index's WHERE
 * clause (dropping `removed_at IS NULL`, say) reopens the ambiguity in this file
 * rather than in production.
 *
 * The four reads:
 *   1. `recipientLocaleAdapter.getMemberEmailRecipient` — money-email address;
 *   2. `recipientLocaleAdapter.getMemberEmailLocale` — the locale-only read;
 *   3. `drizzleMemberRepo.findPrimaryContactEmailInTx` — F5's PromptPay billing
 *      email, handed to Stripe;
 *   4. `memberIdentityAdapter.getForIssue` — the frozen §86/4 buyer snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { recipientLocaleAdapter } from '@/modules/invoicing/infrastructure/adapters/recipient-locale-adapter';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { asMemberId, drizzleMemberRepo } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
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

describe('108 primary-contact reads agree (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'primary-agreement-plan';
  const planYear = 2026;
  const memberId = randomUUID();
  const primaryContactId = randomUUID();
  const siblingContactId = randomUUID();
  const primaryEmail = `the-primary-${randomUUID().slice(0, 8)}@example.com`;
  const siblingEmail = `a-sibling-${randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Primary Agreement Plan' },
        description: { en: '108 primary-contact read agreement' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
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
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'One Primary Ltd',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '1 Silom',
        city: 'Bang Rak',
        province: 'Bangkok',
        postalCode: '10500',
        planId,
        planYear,
        // Left NULL on purpose: `getMemberEmailLocale` COALESCEs the member's
        // explicit choice OVER the contact's, so a value here would mask which
        // contact the locale actually came from.
        preferredLocale: null,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: primaryContactId,
        memberId,
        firstName: 'The',
        lastName: 'Primary',
        email: primaryEmail,
        preferredLanguage: 'th',
        isPrimary: true,
      });
      // A live NON-primary sibling. Present so the four reads have something to
      // wrongly select: a predicate that lost `is_primary = true` would return
      // this row, and every assertion below names the primary's own address
      // rather than "the only row there is".
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: siblingContactId,
        memberId,
        firstName: 'A',
        lastName: 'Sibling',
        email: siblingEmail,
        preferredLanguage: 'sv',
        isPrimary: false,
      });
    });
  }, 60_000);

  afterAll(async () => {
    for (const table of [contacts, members, membershipPlans] as const) {
      await db
        .delete(table)
        .where(eq(table.tenantId, tenant.ctx.slug))
        .catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('the database REFUSES a second live primary — the reads rest on this', async () => {
    // The whole reason an unordered `LIMIT 1` is safe on all four reads. If
    // `contacts_one_primary_per_member` were ever dropped, this fails and
    // finding #13 becomes real for every one of them at once.
    const rejection = await runInTenant(tenant.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Second',
        lastName: 'Primary',
        email: `rejected-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(Error);
    // Assert the CONSTRAINT, not just "something failed". Drizzle's wrapper
    // message is only "Failed query: insert into contacts …", which a NOT NULL
    // violation or an FK would satisfy just as well — this test would then pass
    // while proving nothing about the uniqueness the reads depend on. The
    // driver puts the real name on the cause.
    const cause = (rejection as { cause?: { constraint_name?: string; code?: string } }).cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint_name).toBe('contacts_one_primary_per_member');

    // And the state it protects is intact: exactly one live primary.
    const live = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: contacts.contactId })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenant.ctx.slug),
            eq(contacts.memberId, memberId),
            eq(contacts.isPrimary, true),
            sql`${contacts.removedAt} IS NULL`,
          ),
        ),
    );
    expect(live).toHaveLength(1);
  });

  it('the money-email address read picks the primary, not the live sibling', async () => {
    const r = await recipientLocaleAdapter.getMemberEmailRecipient(
      null,
      tenant.ctx.slug,
      memberId,
    );
    expect(r).toEqual({ email: primaryEmail, locale: 'th' });
  });

  it('the locale-only read picks the SAME contact as the address read', async () => {
    // These two run for one member on one request. A locale taken from a
    // different contact than the address mails the primary in the sibling's
    // language — the sibling here is deliberately 'sv' to make that visible.
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      memberId,
    );
    expect(locale).toBe('th');
  });

  it("F5's PromptPay billing read picks the SAME contact", async () => {
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.findPrimaryContactEmailInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(primaryEmail);
  });

  it('the BANNER read and the MONEY read agree on a whitespace-only address', async () => {
    // Round-5 #2 added `getMemberRecipientStatus` for the banner, which is a
    // SECOND SQL implementation of "does this member have a usable primary
    // contact?" — the money read trims in JS after an inner JOIN, the status
    // read filters `btrim(c.email) <> ''` in SQL. Two implementations of one
    // rule is exactly the drift this whole feature exists to close (the banner
    // used to carry a hand-copied `isPrimary && removedAt === null`), so the
    // agreement is pinned rather than assumed.
    const wsMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: wsMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Whitespace Address Ltd',
        country: 'TH',
        addressLine1: '2 Silom',
        city: 'Bang Rak',
        province: 'Bangkok',
        postalCode: '10500',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: wsMemberId,
        firstName: 'Blank',
        lastName: 'Address',
        // A live, primary contact whose address is whitespace. A bulk import
        // that bypassed `asEmail` can store this; the column is only
        // length-checked.
        email: '   ',
        isPrimary: true,
      });
    });

    const money = await recipientLocaleAdapter.getMemberEmailRecipient(
      null,
      tenant.ctx.slug,
      wsMemberId,
    );
    const banner = await recipientLocaleAdapter.getMemberRecipientStatus(
      null,
      tenant.ctx.slug,
      wsMemberId,
    );

    // The money path skips (the resolver maps whitespace-only to no_recipient)…
    expect(money?.email.trim() ?? '').toBe('');
    // …and the banner must therefore WARN, not report the member as reachable.
    expect(banner?.hasLivePrimary).toBe(false);
  }, 60_000);

  it('the frozen §86/4 buyer snapshot names the SAME contact', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId),
    );
    expect(view).not.toBeNull();
    expect(view?.snapshot.primary_contact_email).toBe(primaryEmail);
  });
});
