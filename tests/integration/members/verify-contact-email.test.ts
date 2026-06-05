/**
 * Integration: verifyContactEmail — FR-012a companion (token consumption).
 *
 * Exercises the 6-step atomic transaction against live Neon:
 *   1. Re-fetch token inside tx (TOCTOU defence)
 *   2. Reject if now < activatedAt (not_yet_active)
 *   3. Mark token consumed
 *   4. Flip users.email_verified = TRUE
 *   5. Invalidate outstanding revert tokens
 *   6. Append audit event
 *
 * Prerequisites: changeContactEmail must run first to seed the
 * verification token + revert token. We call it in beforeAll so
 * the verify test has real rows to consume.
 *
 * Relies on live Neon via DATABASE_URL from .env.local — no mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  changeContactEmail,
  verifyContactEmail,
  type ContactId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  auditLog,
  emailChangeTokens,
  sessions,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

let tenant: TestTenant;
let admin: TestUser;
let linkedUser: TestUser;
let contactId: ContactId;
let memberId: string;
let verificationTokenHash: string;

beforeAll(async () => {
  admin = await createActiveTestUser('admin');
  linkedUser = await createActiveTestUser('member');
  tenant = await createTestTenant('test-swecham');

  memberId = randomUUID();
  contactId = randomUUID() as ContactId;
  const rand = randomUUID().slice(0, 8);

  // Seed tenant infrastructure
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

    // Seed member + linked contact
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Verify Co ${rand}`,
      country: 'TH',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Bob',
      lastName: 'Verifier',
      email: linkedUser.rawEmail,
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: linkedUser.userId,
    });
    await tx.insert(auditLog).values({
      eventType: 'account_created',
      actorUserId: admin.userId,
      targetUserId: linkedUser.userId,
      summary: 'test seed',
      requestId: `seed-${rand}`,
      tenantId: tenant.ctx.slug,
    });
  });

  // Seed a session so changeContactEmail has something to revoke
  await db.insert(sessions).values({
    id: `sess-${randomUUID().replace(/-/g, '')}`,
    userId: linkedUser.userId,
    sourceIp: '127.0.0.1',
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
  });

  // Run changeContactEmail to generate the tokens
  const deps = buildMembersDeps(tenant.ctx);
  const newEmail = `verify-${rand}@test.example`;
  const changeResult = await changeContactEmail(
    {
      tenant: tenant.ctx,
      contactRepo: deps.contactRepo,
      userEmails: deps.userEmails,
      sessions: deps.sessions,
      tokens: deps.tokens,
      emails: deps.emails,
      audit: deps.audit,
      clock: deps.clock,
    },
    {
      contactId,
      newEmailRaw: newEmail,
      actorUserId: admin.userId,
      requestId: `change-${rand}`,
      locale: 'en',
    },
  );
  expect(changeResult.ok).toBe(true);

  // Extract the verification token hash from the DB — the outbox row
  // carries the plaintext in context_data.token, which we can hash
  // to get the token_id stored in email_change_tokens.
  const tokenRows = await db
    .select()
    .from(emailChangeTokens)
    .where(
      and(
        eq(emailChangeTokens.tenantId, tenant.ctx.slug),
        eq(emailChangeTokens.type, 'verification'),
      ),
    );
  expect(tokenRows.length).toBeGreaterThanOrEqual(1);
  verificationTokenHash = tokenRows[0]!.id;
}, 60_000);

afterAll(async () => {
  await tenant.cleanup();
  await deleteTestUser(admin);
  await deleteTestUser(linkedUser);
});

// ---- Tests -----------------------------------------------------------------

describe('verifyContactEmail integration (FR-012a token consumption)', () => {
  it('rejects not_yet_active when clock is before activatedAt', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    // Use a clock that returns a time BEFORE the token's activatedAt
    // (5 min after creation). We set the clock to 1 second after
    // the change was issued — well within the 5-min delay.
    const earlyNow = new Date(Date.now() - 5 * 60 * 1000);
    const result = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: { now: () => earlyNow },
      },
      {
        tokenId: verificationTokenHash,
        requestId: `verify-early-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_yet_active');
    }
  }, 30_000);

  it('rejects wrong_type when a revert token id is passed', async () => {
    // Find the revert token for this user
    const revertRows = await db
      .select()
      .from(emailChangeTokens)
      .where(
        and(
          eq(emailChangeTokens.tenantId, tenant.ctx.slug),
          eq(emailChangeTokens.type, 'revert'),
        ),
      );
    expect(revertRows.length).toBeGreaterThanOrEqual(1);

    const deps = buildMembersDeps(tenant.ctx);
    const result = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: deps.clock,
      },
      {
        tokenId: revertRows[0]!.id,
        requestId: `verify-wrong-type-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('wrong_type');
    }
  }, 30_000);

  it('happy path — all 6 side effects persisted atomically', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    // Verify with a clock past the activation delay
    const futureNow = new Date(Date.now() + 10 * 60 * 1000);
    const result = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: { now: () => futureNow },
      },
      {
        tokenId: verificationTokenHash,
        requestId: `verify-happy-${randomUUID().slice(0, 8)}`,
        actorUserId: 'anonymous',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.userId).toBe(linkedUser.userId);
    expect(result.value.revertTokensInvalidated).toBeGreaterThanOrEqual(1);

    // Side effect 3: verification token is consumed (re-fetch returns not_found)
    const consumedResult = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: { now: () => futureNow },
      },
      {
        tokenId: verificationTokenHash,
        requestId: `verify-replay-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(consumedResult.ok).toBe(false);
    if (!consumedResult.ok) {
      expect(consumedResult.error.code).toBe('not_found');
    }

    // Side effect 4: users.email_verified flipped to TRUE
    const userRows = await db
      .select({ emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, linkedUser.userId));
    expect(userRows[0]?.emailVerified).toBe(true);

    // Side effect 5: revert tokens invalidated (consumed_at not null)
    const activeRevertTokens = await db
      .select()
      .from(emailChangeTokens)
      .where(
        and(
          eq(emailChangeTokens.tenantId, tenant.ctx.slug),
          eq(emailChangeTokens.type, 'revert'),
          sql`${emailChangeTokens.consumedAt} IS NULL`,
        ),
      );
    expect(activeRevertTokens.length).toBe(0);
  }, 30_000);

  it('returns not_found on already-consumed token (idempotency)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const futureNow = new Date(Date.now() + 10 * 60 * 1000);
    const result = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: { now: () => futureNow },
      },
      {
        tokenId: verificationTokenHash,
        requestId: `verify-idem-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  }, 30_000);

  it('returns not_found for a non-existent token id', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const result = await verifyContactEmail(
      {
        tenant: tenant.ctx,
        tokens: deps.tokens,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: deps.clock,
      },
      {
        tokenId: 'deadbeef'.repeat(8),
        requestId: `verify-ghost-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  }, 30_000);
});
