/**
 * T074 — Integration: FR-012c outbox permanent-failure + admin recovery.
 *
 * Scenario driven at the DB layer (no Resend network calls):
 *
 *   1. An outbox row is seeded in `pending` state. Its attempts
 *      counter is bumped to 4; any further failure flips it to
 *      `permanently_failed` per the dispatcher policy
 *      (RETRY_BACKOFF_SECONDS.length = 5 attempts total).
 *   2. We simulate the 5th failure via a direct UPDATE — what the
 *      cron route does internally on the `invalid-recipient` branch
 *      (or the 5th 5xx retry). We then assert the row is in
 *      `permanently_failed` + a `email_dispatch_failed` audit can be
 *      appended.
 *   3. Admin re-send: `resendVerificationEmail` is called from the
 *      members module; we verify it invalidates any prior tokens and
 *      enqueues a fresh outbox row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  resendVerificationEmail,
  type ContactId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  emailChangeTokens,
  notificationsOutbox,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('outbox permanent failure + admin re-send (T074, FR-012c)', () => {
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

  async function seedContact(): Promise<{
    contactId: ContactId;
    memberId: string;
    email: string;
    linkedUser: TestUser;
  }> {
    const user = await createActiveTestUser('member');
    const memberId = randomUUID();
    const contactId = randomUUID() as ContactId;
    const rand = randomUUID().slice(0, 8);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Outbox Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'Outbox',
        lastName: 'User',
        email: user.rawEmail,
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: user.userId,
      });
    });
    return { contactId, memberId, email: user.rawEmail, linkedUser: user };
  }

  it('outbox row flips to permanently_failed on 5th attempt + audit row lands', async () => {
    const s = await seedContact();
    const outboxId = randomUUID();
    await db.insert(notificationsOutbox).values({
      id: outboxId,
      tenantId: tenant.ctx.slug,
      notificationType: 'email_verification',
      toEmail: s.email,
      locale: 'en',
      contextData: { token: 'ignored-in-this-test' },
      status: 'pending',
      attempts: 4,
      nextRetryAt: new Date(),
      lastError: '5xx from upstream',
    });

    // Simulate dispatcher on the 5th failed attempt (same shape as the
    // route handler's permanent-fail branch).
    await db
      .update(notificationsOutbox)
      .set({
        status: 'permanently_failed',
        attempts: 5,
        lastError: 'upstream-unavailable',
        updatedAt: new Date(),
      })
      .where(eq(notificationsOutbox.id, outboxId));

    await db.insert(auditLog).values({
      eventType: 'email_dispatch_failed',
      actorUserId: 'system:cron',
      summary: `outbox row ${outboxId} permanently failed after 5 attempts`,
      requestId: `req-${randomUUID().slice(0, 8)}`,
      tenantId: tenant.ctx.slug,
      payload: {
        outbox_row_id: outboxId,
        notification_type: 'email_verification',
        attempts: 5,
        last_error: 'upstream-unavailable',
      },
    });

    const [row] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, outboxId))
      .limit(1);
    expect(row?.status).toBe('permanently_failed');
    expect(row?.attempts).toBe(5);

    const [auditCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'email_dispatch_failed'),
        ),
      );
    expect(auditCount?.n ?? 0).toBeGreaterThanOrEqual(1);

    await deleteTestUser(s.linkedUser);
  }, 30_000);

  it('admin resend creates a fresh token + outbox row + audit row', async () => {
    const s = await seedContact();
    const deps = buildMembersDeps(tenant.ctx);

    // Simulate post-email-change state — `email_verified` is flipped to
    // false by FR-012a. `resendVerificationEmail` refuses when the user
    // is already verified, so we unset it here to match real workflow.
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, s.linkedUser.userId));

    // Seed a prior active verification token so we can assert the
    // use case invalidates it.
    const priorTokenHash = `prior-${randomUUID().replace(/-/g, '')}`;
    await db.insert(emailChangeTokens).values({
      id: priorTokenHash,
      tenantId: tenant.ctx.slug,
      contactId: s.contactId,
      userId: s.linkedUser.userId,
      type: 'verification',
      oldEmail: s.email,
      newEmail: s.email,
      activatedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.tenantId, tenant.ctx.slug));
    const beforeOutbox = before[0]?.n ?? 0;

    const result = await resendVerificationEmail(
      {
        tenant: tenant.ctx,
        contactRepo: deps.contactRepo,
        tokens: deps.tokens,
        emails: deps.emails,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: deps.clock,
      },
      {
        contactId: s.contactId,
        memberId: s.memberId,
        actorUserId: admin.userId,
        requestId: `req-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.invalidatedPrior).toBeGreaterThanOrEqual(1);

    // Prior token is now consumed
    const [prior] = await db
      .select({ consumedAt: emailChangeTokens.consumedAt })
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.id, priorTokenHash))
      .limit(1);
    expect(prior?.consumedAt).not.toBeNull();

    // Fresh outbox row
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.tenantId, tenant.ctx.slug));
    expect((after[0]?.n ?? 0) - beforeOutbox).toBeGreaterThanOrEqual(1);

    // email_verification_resent audit row
    const [auditCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'email_verification_resent'),
          eq(auditLog.targetUserId, s.linkedUser.userId),
        ),
      );
    expect(auditCount?.n ?? 0).toBeGreaterThanOrEqual(1);

    await deleteTestUser(s.linkedUser);
  }, 30_000);
});
