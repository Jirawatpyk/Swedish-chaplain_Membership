/**
 * Email-locale audit 2026-07-16 — the F4 recipient-locale adapter reads the
 * member's preferred email locale from live Neon with the documented
 * precedence: members.preferred_locale (explicit choice) COALESCEs over the
 * primary contact's preferred_language (NOT NULL DEFAULT 'en').
 *
 * This is the live-Neon guard the pure unit tests can't give — it proves the
 * COALESCE SQL + RLS self-scoping (null-tx standalone read) against the real
 * schema, and that an unset preference falls through to the contact column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { recipientLocaleAdapter } from '@/modules/invoicing/infrastructure/adapters/recipient-locale-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('recipientLocaleAdapter — member email locale (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  // member preferred_locale='th', contact preferred_language='sv'
  let memberPrefersTh: string;
  // member preferred_locale=NULL, contact preferred_language='sv'
  let memberUnsetContactSv: string;
  // member preferred_locale=NULL, contact preferred_language='en' (default)
  let bothDefault: string;
  // 108 — primary contact promoted after issue: the OLD primary is removed
  // (removed_at set, is_primary false) and a new one is live.
  let memberPromoted: string;
  // 108 — every contact removed: no live primary at all.
  let memberNoPrimary: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    memberPrefersTh = randomUUID();
    memberUnsetContactSv = randomUUID();
    bothDefault = randomUUID();
    memberPromoted = randomUUID();
    memberNoPrimary = randomUUID();
    planId = `f4-locale-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Regular Corporate', th: 'สมาชิกองค์กรทั่วไป' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 1_600_000,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      for (const [memberId, memberLocale, contactLang] of [
        [memberPrefersTh, 'th', 'sv'],
        [memberUnsetContactSv, null, 'sv'],
        [bothDefault, null, 'en'],
      ] as const) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Locale Co',
          country: 'TH',
          planId,
          planYear: 2026,
          registrationDate: '2020-01-01',
          preferredLocale: memberLocale,
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Loc',
          lastName: 'Ale',
          email: `loc-${randomUUID().slice(0, 8)}@example.com`,
          isPrimary: true,
          preferredLanguage: contactLang,
        });
      }
    });
    // 108 fixtures — promotion + no-primary.
    await runInTenant(tenant.ctx, async (tx) => {
      for (const memberId of [memberPromoted, memberNoPrimary]) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Promote Co',
          country: 'TH',
          planId,
          planYear: 2026,
          registrationDate: '2020-01-01',
          preferredLocale: null,
        });
      }
      // The FORMER primary: removed, and (per the F3 invariant) no longer
      // primary. Its preferred_language is 'th' so a read that wrongly picks it
      // is visible in the locale as well as the address.
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: memberPromoted,
        firstName: 'Former',
        lastName: 'Primary',
        email: 'former-primary@example.com',
        isPrimary: false,
        removedAt: new Date(),
        preferredLanguage: 'th',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: memberPromoted,
        firstName: 'Current',
        lastName: 'Primary',
        email: 'current-primary@example.com',
        isPrimary: true,
        preferredLanguage: 'sv',
      });
      // memberNoPrimary keeps one removed, non-primary contact — every contact
      // gone. (A removed row that stayed `is_primary` is not seedable: the 0009
      // CHECK `contacts_primary_not_removed` rejects it, which is why the
      // adapters' own `removed_at IS NULL` is belt-and-braces, not a fix.)
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: memberNoPrimary,
        firstName: 'Gone',
        lastName: 'Contact',
        email: 'gone-contact@example.com',
        isPrimary: false,
        removedAt: new Date(),
        preferredLanguage: 'th',
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('member preferred_locale wins over the contact column (explicit choice beats default)', async () => {
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      memberPrefersTh,
    );
    expect(locale).toBe('th');
  });

  it('falls back to the primary contact language when member preference is unset', async () => {
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      memberUnsetContactSv,
    );
    expect(locale).toBe('sv');
  });

  it('resolves to en when both are the default (no explicit preference anywhere)', async () => {
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      bothDefault,
    );
    expect(locale).toBe('en');
  });

  it('returns null for a member that does not exist (outbox applies its own en default)', async () => {
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      randomUUID(),
    );
    expect(locale).toBeNull();
  });

  it('reuses a threaded tenant tx (same RLS context) when one is supplied', async () => {
    const locale = await runInTenant(tenant.ctx, (tx) =>
      recipientLocaleAdapter.getMemberEmailLocale(tx, tenant.ctx.slug, memberPrefersTh),
    );
    expect(locale).toBe('th');
  });

  // ── 108 FR-001 — the live money-email recipient ─────────────────────────

  it('getMemberEmailRecipient returns the CURRENT primary, not the removed former one', async () => {
    const recipient = await recipientLocaleAdapter.getMemberEmailRecipient(
      null,
      tenant.ctx.slug,
      memberPromoted,
    );
    expect(recipient).toEqual({ email: 'current-primary@example.com', locale: 'sv' });
  });

  it('getMemberEmailRecipient returns null when no live primary contact exists', async () => {
    const recipient = await recipientLocaleAdapter.getMemberEmailRecipient(
      null,
      tenant.ctx.slug,
      memberNoPrimary,
    );
    expect(recipient).toBeNull();
  });

  it('getMemberEmailRecipient returns null for a member that does not exist', async () => {
    const recipient = await recipientLocaleAdapter.getMemberEmailRecipient(
      null,
      tenant.ctx.slug,
      randomUUID(),
    );
    expect(recipient).toBeNull();
  });

  it('getMemberEmailRecipient reuses a threaded tenant tx', async () => {
    const recipient = await runInTenant(tenant.ctx, (tx) =>
      recipientLocaleAdapter.getMemberEmailRecipient(tx, tenant.ctx.slug, memberPromoted),
    );
    expect(recipient?.email).toBe('current-primary@example.com');
  });

  it('a member with no live primary has no locale either (COALESCE yields null)', async () => {
    // The removed contact's 'th' must not answer for the member: the subquery
    // matches nothing and the outbox applies its own 'en' default.
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      memberNoPrimary,
    );
    expect(locale).toBeNull();
  });

  it('the promoted member reads the CURRENT primary language', async () => {
    const locale = await recipientLocaleAdapter.getMemberEmailLocale(
      null,
      tenant.ctx.slug,
      memberPromoted,
    );
    expect(locale).toBe('sv');
  });
});
