/**
 * COMP-1 US2b Task 1 — `app.allow_broadcast_redaction` GUC exemption arm
 * on `broadcasts_immutable_after_submit_fn`.
 *
 * GDPR Art.17 / PDPA §33 member erasure must redact the PII a member
 * authored into a broadcast (subject/body/from_name/reply_to_email/
 * custom_recipient_emails) even AFTER the broadcast left `draft`. The
 * immutability trigger (migration 0064 → amended 0075) normally locks
 * those columns post-submit. Migration 0224 adds a GUC-gated exemption
 * arm (mirrors F4's `app.allow_pii_redaction`): under
 * `SET LOCAL app.allow_broadcast_redaction = 'on'` the PII content
 * columns MAY change, but a NON-PII column (segment_type/segment_params/
 * scheduled_for) change still RAISEs `broadcast_redaction_only_pii_cols`.
 *
 * Seeds a real broadcast through `draft → submitted` (so the row is past
 * the `OLD.status != 'draft'` predicate) and issues raw UPDATEs to
 * verify each arm. Mirrors the live-DB seed pattern in
 * `immutable-after-submit.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

/**
 * Drizzle wraps the Postgres trigger exception so a top-level
 * `rejects.toThrow` does not match. Walk the `cause` chain with
 * `errorChainMessage` and substring-assert the RAISE EXCEPTION text.
 */
async function expectRaiseInChain(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (caught === null) {
    throw new Error('Expected trigger to raise but UPDATE succeeded silently');
  }
  const chain = errorChainMessage(caught);
  if (!pattern.test(chain)) {
    throw new Error(
      `Expected ${pattern} in cause chain but got: ${chain}`,
    );
  }
}

describe('broadcasts_immutable_after_submit_fn — app.allow_broadcast_redaction GUC', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    planId = `redact-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Redact Plan' },
        description: { en: 'Test description' },
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
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Redact Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  /** Seed a fresh submitted broadcast and return its id. */
  async function seedSubmittedBroadcast(): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'Original subject',
        bodyHtml: '<p>original body</p>',
        bodySource: 'original body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        // NOTE: `broadcasts_custom_recipient_cap` (0064) forces
        // custom_recipient_emails IS NULL when segment_type != 'custom'.
        // Seed NULL here (segment=all_members); the GUC-allowed case below
        // still verifies a `custom_recipient_emails = NULL` redaction UPDATE
        // is permitted past the immutability trigger.
        customRecipientEmails: null,
        estimatedRecipientCount: 100,
        status: 'submitted',
        submittedAt: new Date(),
      }),
    );
    return broadcastId;
  }

  /**
   * Seed a fresh submitted `custom` broadcast with a valid 2-element
   * custom_recipient_emails array (the `broadcasts_custom_recipient_cap`
   * CHECK, migration 0064, requires a 1–100 element array on custom rows).
   */
  async function seedSubmittedCustomBroadcast(): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'Original subject',
        bodyHtml: '<p>original body</p>',
        bodySource: 'original body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'custom',
        segmentParams: null,
        customRecipientEmails: ['a@x.com', 'b@x.com'],
        estimatedRecipientCount: 100,
        status: 'submitted',
        submittedAt: new Date(),
      }),
    );
    return broadcastId;
  }

  it('RAISEs on a content UPDATE of a submitted broadcast WITHOUT the GUC', async () => {
    const broadcastId = await seedSubmittedBroadcast();
    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, (tx) =>
          tx
            .update(broadcasts)
            .set({ subject: '[redacted]' })
            .where(eq(broadcasts.broadcastId, broadcastId)),
        ),
      /broadcast_immutable_after_submit/,
    );
  });

  it('ALLOWS the PII content UPDATE under SET LOCAL app.allow_broadcast_redaction = on', async () => {
    const broadcastId = await seedSubmittedBroadcast();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      await tx.execute(sql`
        UPDATE broadcasts
        SET subject = '[redacted]', body_html = '[redacted]', body_source = '[redacted]',
            from_name = '[redacted]', reply_to_email = '[redacted]',
            custom_recipient_emails = NULL
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
      `);
    });

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({
          subject: broadcasts.subject,
          bodyHtml: broadcasts.bodyHtml,
          customRecipientEmails: broadcasts.customRecipientEmails,
        })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.subject).toBe('[redacted]');
    expect(row?.bodyHtml).toBe('[redacted]');
    expect(row?.customRecipientEmails).toBeNull();
  });

  it('still RAISEs under the GUC if a NON-PII column (segment_type) changes', async () => {
    const broadcastId = await seedSubmittedBroadcast();
    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            UPDATE broadcasts SET segment_type = 'tier'
            WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
          `);
        }),
      /broadcast_redaction_only_pii_cols/,
    );
  });

  it('still RAISEs under the GUC if a NON-TARGETING immutable column (status) changes [whitelist regression]', async () => {
    // /code-review #14: the original 0224 GUC arm was a BLOCKLIST that only
    // RAISEd on segment_type/segment_params/scheduled_for changes — a
    // `status` change under the GUC SUCCEEDED silently (the audit-trail-
    // mutation hole the whitelist closes). `submitted → approved` is a VALID
    // state-machine transition, so the state-machine trigger would NOT block
    // it; only the whitelist immutability arm does. Confirm-can-fail: revert
    // 0224 to the blocklist and this case turns green (UPDATE succeeds).
    const broadcastId = await seedSubmittedBroadcast();
    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            UPDATE broadcasts SET status = 'approved'
            WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
          `);
        }),
      /broadcast_redaction_only_pii_cols/,
    );
  });

  it('still RAISEs under the GUC if the composite-PK broadcast_id changes [PK-whitelist regression]', async () => {
    // 2026-06-19 /code-review #5/#6: the original 0224 GUC whitelist enumerated
    // the forbidden NON-PII columns but OMITTED the composite-PK columns
    // (tenant_id + broadcast_id) — the sibling 0225 deliveries arm forbids
    // tenant_id/delivery_id/broadcast_id, so 0224 was asymmetric. No live
    // exploit (the scrub never touches the PK), but a latent defense-in-depth
    // gap the migration claimed to close. After the amendment a broadcast_id
    // rewrite under the GUC RAISEs. Confirm-can-fail: revert the
    // `NEW.broadcast_id IS DISTINCT FROM OLD.broadcast_id` arm and this case
    // turns green (the PK UPDATE succeeds silently).
    const broadcastId = await seedSubmittedBroadcast();
    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            UPDATE broadcasts SET broadcast_id = ${randomUUID()}
            WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
          `);
        }),
      /broadcast_redaction_only_pii_cols/,
    );
  });

  it('ALLOWS a failure_reason redaction under the GUC (PII whitelist) [#8]', async () => {
    // 2026-06-19 /code-review #8: failure_reason is set from a raw gateway
    // error message that can echo the author's own reply_to_email/from_name,
    // so the scrub NULLs it. The 0224 amendment MOVED failure_reason from the
    // forbidden enumeration into the PII whitelist so the GUC arm permits this
    // change. Seed a row with a failure_reason embedding the author email,
    // redact it to NULL under the GUC, assert no RAISE + value is NULL.
    // Confirm-can-fail: re-add the
    // `NEW.failure_reason IS DISTINCT FROM OLD.failure_reason` forbidden arm
    // and this UPDATE RAISEs broadcast_redaction_only_pii_cols.
    const broadcastId = await seedSubmittedBroadcast();
    const authorEmail = 'reply@example.com'; // the seeded reply_to_email
    await runInTenant(tenant.ctx, async (tx) => {
      // Stamp a failure_reason echoing the author email (as the gateway would).
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      await tx.execute(sql`
        UPDATE broadcasts SET failure_reason = ${`550 5.1.1 <${authorEmail}> rejected`}
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
      `);
    });

    // Now redact it to NULL under the GUC — must be permitted (no RAISE).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      await tx.execute(sql`
        UPDATE broadcasts SET failure_reason = NULL
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
      `);
    });

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT failure_reason FROM broadcasts
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
      `)) as unknown as Array<{ failure_reason: string | null }>;
      return rows[0];
    });
    expect(row?.failure_reason).toBeNull();
  });

  it('ALLOWS a custom_recipient_emails redaction on a custom row under the GUC (no trigger RAISE, no cap-CHECK violation)', async () => {
    // The prior allow-case redacts custom_recipient_emails → NULL on a
    // NON-custom row. On a `custom` row the repo redacts to the 1-element
    // ['[redacted]'] array (a NULL would violate broadcasts_custom_recipient_cap).
    // Prove the immutability trigger permits the custom-array change AND the
    // cap CHECK is satisfied by the redacted array.
    const broadcastId = await seedSubmittedCustomBroadcast();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      await tx.execute(sql`
        UPDATE broadcasts
        SET subject = '[redacted]', body_html = '[redacted]', body_source = '[redacted]',
            from_name = '[redacted]', reply_to_email = '[redacted]',
            custom_recipient_emails = ARRAY['[redacted]']::text[]
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}
      `);
    });

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({
          subject: broadcasts.subject,
          customRecipientEmails: broadcasts.customRecipientEmails,
        })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.subject).toBe('[redacted]');
    expect(row?.customRecipientEmails).toEqual(['[redacted]']);
  });
});
