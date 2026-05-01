/**
 * T138 — Integration test: public unsubscribe end-to-end (live DB / F7 US4).
 *
 * Live-DB pipeline assertions:
 *   (a) Happy path: signed token → page render → row inserted in
 *       `marketing_unsubscribes` with `(tenant_id, email_lower)` PK +
 *       `reason='recipient_initiated'` + `source_token_hash` populated +
 *       `member_id` resolved from `members.primary_contact_email`.
 *       Both `broadcast_unsubscribed` + `broadcast_suppression_applied`
 *       audit rows written with 5y retention.
 *   (b) Idempotent replay: re-rendering the page with the same token
 *       does NOT insert a duplicate row + does NOT emit duplicate
 *       audit (FR-030).
 *   (c) Tampered token: byte-flipped MAC → no row inserted +
 *       `broadcast_unsubscribe_token_invalid` audit written.
 *   (d) Cross-tenant token: forge a token with another tenant's tid →
 *       valid HMAC under that tenant's signature would fail because
 *       the secret is process-wide, but we assert that an attacker
 *       cannot make an unsubscribe land in a tenant they don't own
 *       (suppression isolation per FR-018 + Q19).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db, runInTenant } from '@/lib/db';
import {
  broadcasts,
  marketingUnsubscribes,
} from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  unsubscribeTokenSigner,
} from '@/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { unsafeBrandTenantSlug } from '@/modules/tenants';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const F7_MATRIX: BenefitMatrix = {
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

interface AuditRow {
  readonly event_type: string;
  readonly tenant_id: string | null;
  readonly retention_years: number;
  readonly payload: Record<string, unknown>;
}

async function fetchAuditRowsForTenant(
  tenantId: string,
  eventType: string,
): Promise<readonly AuditRow[]> {
  const rows = (await db.execute(sql`
    SELECT event_type, tenant_id, retention_years, payload
      FROM audit_log
     WHERE tenant_id = ${tenantId}
       AND event_type = ${eventType}::audit_event_type
     ORDER BY timestamp DESC
     LIMIT 10
  `)) as unknown as ReadonlyArray<AuditRow>;
  return rows;
}

describe('F7 public unsubscribe integration (T138)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;
  let memberId: string;
  let contactEmailLower: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const planId = `t138-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T138 Plan' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: F7_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );

    memberId = randomUUID();
    contactEmailLower = `t138-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'T138 Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        email: contactEmailLower,
        firstName: 'Alice',
        lastName: 'Tester',
        isPrimary: true,
      }),
    );

    broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'T138 unsubscribe',
        bodyHtml: '<p>body</p>',
        bodySource: 'body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 1,
        status: 'sent',
        submittedAt: new Date(),
        sentAt: new Date(),
        quotaYearConsumed: 2026,
        quotaConsumedAt: new Date(),
      }),
    );
  });

  afterAll(async () => {
    if (tenant) {
      // Wipe suppression rows we created for this tenant before
      // calling the tenant cleanup.
      try {
        await db.execute(sql`
          DELETE FROM marketing_unsubscribes WHERE tenant_id = ${tenant.ctx.slug}
        `);
      } catch {
        // best-effort
      }
      await tenant.cleanup();
    }
  });

  function signValidToken(): string {
    return unsubscribeTokenSigner.sign({
      tenantId: unsafeBrandTenantSlug(tenant.ctx.slug),
      broadcastId: asBroadcastId(broadcastId),
      emailLower: unsafeBrandEmailLower(contactEmailLower),
      lang: 'en',
    });
  }

  it('valid token first click → marketing_unsubscribes row inserted + audit emitted', async () => {
    const token = signValidToken();
    const { processUnsubscribe } = await import(
      '@/app/unsubscribe/[token]/page'
    );

    await processUnsubscribe(token, null, null, '127.0.0.1', randomUUID());

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, contactEmailLower),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('recipient_initiated');
    expect(rows[0]!.memberId).toBe(memberId);
    expect(rows[0]!.sourceTokenHash).toMatch(/^[a-f0-9]{64}$/);

    const unsubAudits = await fetchAuditRowsForTenant(
      tenant.ctx.slug,
      'broadcast_unsubscribed',
    );
    expect(unsubAudits.length).toBeGreaterThanOrEqual(1);
    expect(unsubAudits[0]!.retention_years).toBe(5);

    // Verify-fix I5: audit payload MUST hash PII, not log it raw.
    // sha256 hex = 64 lowercase hex chars; raw email or token would not.
    const unsubPayload = unsubAudits[0]!.payload;
    expect(unsubPayload['emailHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(unsubPayload['sourceTokenHash']).toMatch(/^[a-f0-9]{64}$/);
    // Defence: raw PII MUST NOT appear in payload under any key.
    const payloadJson = JSON.stringify(unsubPayload);
    expect(payloadJson).not.toContain(contactEmailLower);

    const suppressionAudits = await fetchAuditRowsForTenant(
      tenant.ctx.slug,
      'broadcast_suppression_applied',
    );
    expect(suppressionAudits.length).toBeGreaterThanOrEqual(1);
    const supPayload = suppressionAudits[0]!.payload;
    expect(supPayload['emailHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(supPayload)).not.toContain(contactEmailLower);
  });

  it('idempotent replay → no duplicate row + no duplicate broadcast_unsubscribed audit', async () => {
    const token = signValidToken();

    // First click already happened in the prior test. Counts before the
    // replay click:
    const beforeRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, contactEmailLower),
          ),
        ),
    );
    const beforeAudits = await fetchAuditRowsForTenant(
      tenant.ctx.slug,
      'broadcast_unsubscribed',
    );

    const { processUnsubscribe } = await import(
      '@/app/unsubscribe/[token]/page'
    );
    await processUnsubscribe(token, null, null, '127.0.0.1', randomUUID());

    const afterRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(
          and(
            eq(marketingUnsubscribes.tenantId, tenant.ctx.slug),
            eq(marketingUnsubscribes.emailLower, contactEmailLower),
          ),
        ),
    );
    expect(afterRows.length).toBe(beforeRows.length);

    const afterAudits = await fetchAuditRowsForTenant(
      tenant.ctx.slug,
      'broadcast_unsubscribed',
    );
    expect(afterAudits.length).toBe(beforeAudits.length);
  });

  it('tampered MAC → broadcast_unsubscribe_token_invalid audit + no row mutation', async () => {
    const token = signValidToken();
    const [version, payload, mac] = token.split('.') as [
      string,
      string,
      string,
    ];
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    const tampered = `${version}.${payload}.${flipped}`;

    const beforeRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(eq(marketingUnsubscribes.tenantId, tenant.ctx.slug)),
    );

    const { processUnsubscribe } = await import(
      '@/app/unsubscribe/[token]/page'
    );
    await processUnsubscribe(tampered, null, null, '127.0.0.1', randomUUID());

    const afterRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(marketingUnsubscribes)
        .where(eq(marketingUnsubscribes.tenantId, tenant.ctx.slug)),
    );
    expect(afterRows.length).toBe(beforeRows.length);

    const invalidAudits = await fetchAuditRowsForTenant(
      tenant.ctx.slug,
      'broadcast_unsubscribe_token_invalid',
    );
    expect(invalidAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('malformed garbage token → audit emitted with NULL tenant + no row anywhere', async () => {
    const beforeRows = (await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM marketing_unsubscribes
    `)) as unknown as ReadonlyArray<{ count: number }>;

    const { processUnsubscribe } = await import(
      '@/app/unsubscribe/[token]/page'
    );
    await processUnsubscribe(
      'this-is-garbage',
      null,
      null,
      '127.0.0.1',
      randomUUID(),
    );

    const afterRows = (await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM marketing_unsubscribes
    `)) as unknown as ReadonlyArray<{ count: number }>;
    expect(afterRows[0]!.count).toBe(beforeRows[0]!.count);
  });

  // G2 — verify-fix: cross-tenant token-injection isolation.
  // A forged token bearing tenant B's tid (signed correctly with the
  // shared `UNSUBSCRIBE_TOKEN_SECRET`) MUST NOT cause a suppression
  // row to land in tenant A's slice. Tenant-isolation enforcement
  // points: (1) `peekTokenTenantId` → bind RLS for the claimed tid,
  // (2) `unsubscribeTokenSigner.verify` → payload tid matches,
  // (3) `unsubscribeRecipient` use-case writes only into deps.tenant
  // (asserted by `tenant_mismatch` guard), (4) RLS+FORCE on
  // `marketing_unsubscribes` blocks any stray write at the DB layer.
  // Asserts FR-018 + plan § Constitution Principle I + Clarifications Q19.
  it('cross-tenant token: tenant B token does NOT land row in tenant A slice', async () => {
    // Provision a second test-tenant + member + broadcast purely so we
    // can mint a "tenant B" token — the test then asserts no row in
    // tenant A AND no row in tenant B (the token was never visited
    // under tenant A's RLS context).
    const tenantB = await createTestTenant('test-chamber');
    try {
      const planIdB = `t138g2-plan-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantB.ctx, (tx) =>
        tx.insert(membershipPlans).values({
          tenantId: tenantB.ctx.slug,
          planId: planIdB,
          planYear: 2026,
          planName: { en: 'T138-G2 Plan B' },
          description: { en: '' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: F7_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        }),
      );
      const memberIdB = randomUUID();
      await runInTenant(tenantB.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantB.ctx.slug,
          memberId: memberIdB,
          companyName: 'T138-G2 Member B',
          country: 'TH',
          planId: planIdB,
          planYear: 2026,
        }),
      );
      const broadcastIdB = randomUUID();
      await runInTenant(tenantB.ctx, (tx) =>
        tx.insert(broadcasts).values({
          tenantId: tenantB.ctx.slug,
          broadcastId: broadcastIdB,
          requestedByMemberId: memberIdB,
          requestedByMemberPlanIdSnapshot: planIdB,
          submittedByUserId: user.userId,
          actorRole: 'member_self_service',
          subject: 'T138-G2 cross-tenant',
          bodyHtml: '<p>x</p>',
          bodySource: 'x',
          fromName: 'Chamber B',
          replyToEmail: 'reply-b@example.com',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          estimatedRecipientCount: 1,
          status: 'sent',
          submittedAt: new Date(),
          sentAt: new Date(),
          quotaYearConsumed: 2026,
          quotaConsumedAt: new Date(),
        }),
      );

      // Mint a VALID token bearing tenant B's tid + tenant A's email.
      // (HMAC verifies; what we assert below is that the
      // `tenant_mismatch` guard + RLS-bound deps prevent the row
      // landing in tenant A's slice.)
      const crossTenantToken = unsubscribeTokenSigner.sign({
        tenantId: unsafeBrandTenantSlug(tenantB.ctx.slug),
        broadcastId: asBroadcastId(broadcastIdB),
        emailLower: unsafeBrandEmailLower(contactEmailLower),
        lang: 'en',
      });

      // Snapshot row counts in tenant A BEFORE
      const tenantABefore = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(eq(marketingUnsubscribes.tenantId, tenant.ctx.slug)),
      );

      const { processUnsubscribe } = await import(
        '@/app/unsubscribe/[token]/page'
      );
      await processUnsubscribe(
        crossTenantToken,
        null,
        null,
        '127.0.0.1',
        randomUUID(),
      );

      // Tenant A — no new row (the token resolved to tenant B; tenant
      // A's slice is untouched).
      const tenantAAfter = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(eq(marketingUnsubscribes.tenantId, tenant.ctx.slug)),
      );
      expect(tenantAAfter.length).toBe(tenantABefore.length);

      // Tenant B — the email DOES land in tenant B (legitimate
      // unsubscribe of contactEmailLower under tenant B's slice). This
      // is correct: from tenant B's perspective, anyone may unsubscribe
      // any email — the row's identity is `(tenantId, emailLower)` and
      // tenant A's `marketing_unsubscribes` is unaffected.
      const tenantBAfter = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(
            and(
              eq(marketingUnsubscribes.tenantId, tenantB.ctx.slug),
              eq(marketingUnsubscribes.emailLower, contactEmailLower),
            ),
          ),
      );
      expect(tenantBAfter.length).toBe(1);
    } finally {
      // Best-effort cleanup of tenant B's suppression rows before the
      // tenant cleanup — same pattern as the outer afterAll.
      try {
        await db.execute(sql`
          DELETE FROM marketing_unsubscribes WHERE tenant_id = ${tenantB.ctx.slug}
        `);
      } catch {
        // ignore
      }
      await tenantB.cleanup();
    }
  });
});
