/**
 * COMP-1 US2b Task 2 — `scrubContentForMemberInTx` +
 * `tombstoneDeliveriesForMemberInTx` on the Drizzle broadcasts repo.
 *
 * GDPR Art.17 / PDPA §33 member erasure must (a) redact the PII a member
 * authored into their broadcasts (subject/body/from_name/reply_to_email/
 * custom_recipient_emails) even after the broadcast left `draft`, and
 * (b) tombstone every `broadcast_deliveries` row that pointed at the
 * erased member (recipient_member_id → NULL, recipient_email_lower →
 * `erased+<delivery_id>@erased.invalid`) WITHOUT deleting the row
 * (record-of-processing retained per PDPA §39 + GDPR Art.30).
 *
 * Both writes run inside `runInTenant` (role `chamber_app`, RLS bound)
 * via a plain UPDATE — NO `ALTER TABLE … DISABLE TRIGGER` (chamber_app
 * is not the table owner and lacks that privilege). Migration 0225
 * (1) GRANTs chamber_app UPDATE on broadcast_deliveries and (2) adds a
 * GUC-gated (`app.allow_broadcast_redaction = 'on'`) UPDATE-only
 * exemption arm to `broadcast_deliveries_append_only_fn`; DELETE stays
 * permanently blocked. Migration 0224 already added the matching arm to
 * `broadcasts_immutable_after_submit_fn`.
 *
 * Seeds via the live Neon DB (same pattern as redaction-guc-trigger /
 * us3-tenant-isolation): broadcasts through `draft`/`submitted`, and
 * delivery rows via the chamber_app INSERT grant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asMemberId } from '@/modules/members';
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

describe('broadcasts repo — scrubContentForMemberInTx + tombstoneDeliveriesForMemberInTx (COMP-1 US2b)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    planId = `scrub-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Scrub Plan' },
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
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Scrub Member',
        country: 'TH',
        planId,
        planYear: 2026,
      });
    });
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  type Segment = 'all_members' | 'custom';

  /**
   * Seed a broadcast authored by `memberId` (or `owner`) at a given status.
   * For `custom` segment, seed a real custom_recipient_emails array (the
   * broadcasts_custom_recipient_cap CHECK requires a 1–100 array on custom
   * rows). `customEmails` overrides the default 2-element array so a test can
   * seed a specific recipient set (e.g. a sibling author's list holding the
   * erased member's email).
   */
  async function seedBroadcast(opts: {
    status: 'draft' | 'submitted';
    segment: Segment;
    owner?: string;
    customEmails?: readonly string[];
    rejectionReason?: string;
    cancellationReason?: string;
    failureReason?: string;
  }): Promise<string> {
    const broadcastId = randomUUID();
    const segment = opts.segment;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: opts.owner ?? memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'Original subject',
        bodyHtml: '<p>original body</p>',
        bodySource: 'original body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: segment,
        segmentParams: null,
        customRecipientEmails:
          segment === 'custom'
            ? [...(opts.customEmails ?? ['a@x.com', 'b@x.com'])]
            : null,
        estimatedRecipientCount: 100,
        status: opts.status,
        submittedAt: opts.status === 'submitted' ? new Date() : null,
        ...(opts.rejectionReason !== undefined && {
          rejectionReason: opts.rejectionReason,
        }),
        ...(opts.cancellationReason !== undefined && {
          cancellationReason: opts.cancellationReason,
        }),
        ...(opts.failureReason !== undefined && {
          failureReason: opts.failureReason,
        }),
      }),
    );
    return broadcastId;
  }

  /**
   * Seed a delivery row at a given `recipientEmailLower` via the chamber_app
   * INSERT grant, in the PRODUCTION shape: `recipient_member_id = NULL` (the
   * webhook is the only inserter and hard-codes null — it never resolves the
   * recipient to a member). The delivery is correlated to a member ONLY by its
   * `recipient_email_lower`, which is the axis the tombstone now matches on.
   * `errorMessage` lets a test seed a raw bounce diagnostic that embeds the
   * recipient email (the PII-residual the tombstone must also scrub).
   */
  async function seedDelivery(
    recipientEmailLower: string,
    opts?: { errorMessage?: string },
  ): Promise<string> {
    const deliveryId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcastDeliveries).values({
        tenantId: tenant.ctx.slug,
        deliveryId,
        broadcastId: randomUUID(),
        recipientEmailLower,
        // PRODUCTION shape: the Resend webhook hard-codes recipient_member_id
        // = NULL at every insert site (process-webhook-event.ts:173,221); no
        // resolver/backfill ever populates it. A seed that set it (the old
        // masking pattern) tested a value production never writes.
        recipientMemberId: null,
        status:
          opts?.errorMessage !== undefined ? 'bounced' : 'delivered',
        eventTimestamp: new Date(),
        resendEventId: `evt-${randomUUID()}`,
        resendMessageId: `msg-${randomUUID()}`,
        ...(opts?.errorMessage !== undefined && {
          errorMessage: opts.errorMessage,
        }),
      }),
    );
    return deliveryId;
  }

  it('redacts a submitted broadcast content (subject/body/from_name/reply_to_email)', async () => {
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'all_members',
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );
    expect(result.scrubbedCount).toBeGreaterThanOrEqual(1);

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({
          subject: broadcasts.subject,
          bodyHtml: broadcasts.bodyHtml,
          bodySource: broadcasts.bodySource,
          fromName: broadcasts.fromName,
          replyToEmail: broadcasts.replyToEmail,
        })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.subject).toBe('[redacted]');
    expect(row?.bodyHtml).toBe('[redacted]');
    expect(row?.bodySource).toBe('[redacted]');
    expect(row?.fromName).toBe('[redacted]');
    expect(row?.replyToEmail).toBe('[redacted]');
  });

  it('custom-segment broadcast keeps a valid 1-element array (no cap CHECK violation)', async () => {
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'custom',
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    // A plain `custom_recipient_emails = NULL` would violate
    // `broadcasts_custom_recipient_cap` on this custom row; the CASE in
    // the repo method keeps it a 1-element ['[redacted]'] array.
    await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ custom: broadcasts.customRecipientEmails })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.custom).toEqual(['[redacted]']);
  });

  it('non-custom broadcast → custom_recipient_emails NULL', async () => {
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'all_members',
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ custom: broadcasts.customRecipientEmails })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.custom).toBeNull();
  });

  it('draft broadcast is also scrubbed (drafts hold PII; trigger early-returns)', async () => {
    const draftId = await seedBroadcast({
      status: 'draft',
      segment: 'all_members',
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ subject: broadcasts.subject })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, draftId));
      return rows[0];
    });
    expect(row?.subject).toBe('[redacted]');
  });

  it('scrubs rejection_reason + cancellation_reason free text (admin/user notes can quote the member email)', async () => {
    // reject-broadcast.ts / cancel-broadcast.ts persist the admin/user note
    // verbatim. On a member-originated broadcast that was rejected/cancelled
    // with a note quoting the member (e.g. "rejected — contains erik@acme.com")
    // that plaintext survives erasure unless the scrub NULLs both columns.
    const rejectEmail = `reject-quote-${randomUUID().slice(0, 8)}@example.com`;
    const cancelEmail = `cancel-quote-${randomUUID().slice(0, 8)}@example.com`;
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'all_members',
      rejectionReason: `rejected — contains ${rejectEmail}`,
      cancellationReason: `cancelled — requested by ${cancelEmail}`,
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({
          rejectionReason: broadcasts.rejectionReason,
          cancellationReason: broadcasts.cancellationReason,
        })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    // Both nullable free-text reason columns are NULLed — no member email
    // survives as plaintext (GDPR Art.17 / PDPA §33).
    expect(row?.rejectionReason).toBeNull();
    expect(row?.cancellationReason).toBeNull();
  });

  it('scrubs failure_reason (raw gateway error can echo the author own reply_to/from_name)', async () => {
    // 2026-06-19 /code-review #8: failure_reason is set from a raw gateway
    // error message (dispatch-scheduled-broadcast.ts: shape.reason ?? e.message)
    // that can embed the broadcast's reply_to_email / from_name — the author's
    // OWN PII, the same address the scrub redacts on that row. The scrub must
    // NULL it (migration 0224 whitelists the column under the GUC).
    const authorEmail = `author-fail-${randomUUID().slice(0, 8)}@example.com`;
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'all_members',
      failureReason: `550 5.1.1 <${authorEmail}> rejected by remote gateway`,
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(tx, tenant.ctx.slug, asMemberId(memberId)),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ failureReason: broadcasts.failureReason })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    // The author email no longer survives as plaintext in failure_reason.
    expect(row?.failureReason).toBeNull();
  });

  it('re-drive over an already-scrubbed member returns scrubbedCount 0 (changed-rows, not matched)', async () => {
    // 2026-06-19 /code-review #4: the content UPDATE now filters on
    // `subject <> '[redacted]'`, so a second pass over already-scrubbed rows
    // matches NOTHING — scrubbedCount reflects rows CHANGED, not rows MATCHED.
    // The use-case zero-work guard relies on this to avoid a DUPLICATE
    // broadcast_content_redacted audit on every reconciler re-drive.
    const redriveMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: redriveMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Redrive Member',
        country: 'TH',
        planId,
        planYear: 2026,
      });
    });
    await seedBroadcast({
      status: 'submitted',
      segment: 'all_members',
      owner: redriveMemberId,
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const first = await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(
        tx,
        tenant.ctx.slug,
        asMemberId(redriveMemberId),
      ),
    );
    expect(first.scrubbedCount).toBeGreaterThanOrEqual(1);

    // Second pass: every row is already '[redacted]' → 0 rows CHANGED.
    const second = await runInTenant(tenant.ctx, (tx) =>
      repo.scrubContentForMemberInTx(
        tx,
        tenant.ctx.slug,
        asMemberId(redriveMemberId),
      ),
    );
    expect(second.scrubbedCount).toBe(0);
  });

  it('tombstones the erased member deliveries (matched by email); a different member is untouched', async () => {
    // PRODUCTION shape: each delivery has recipient_member_id = NULL and is
    // correlated to its member ONLY by recipient_email_lower. The erased member
    // is identified by its email SET; the tombstone matches on that set.
    const erasedEmail = `erased-member-${randomUUID().slice(0, 8)}@example.com`;
    const otherEmail = `other-member-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(erasedEmail);
    const otherDeliveryId = await seedDelivery(otherEmail);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, [erasedEmail]),
    );
    expect(result.tombstonedCount).toBeGreaterThanOrEqual(1);

    const rows = await runInTenant(tenant.ctx, async (tx) => {
      return (await tx.execute(sql`
        SELECT delivery_id, recipient_member_id, recipient_email_lower
        FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug}
          AND delivery_id IN (${deliveryId}, ${otherDeliveryId})
      `)) as unknown as Array<{
        delivery_id: string;
        recipient_member_id: string | null;
        recipient_email_lower: string;
      }>;
    });
    const erased = rows.find((r) => r.delivery_id === deliveryId);
    const untouched = rows.find((r) => r.delivery_id === otherDeliveryId);

    expect(erased?.recipient_member_id).toBeNull();
    expect(erased?.recipient_email_lower).toMatch(/^erased\+/);
    expect(erased?.recipient_email_lower).toContain('@erased.invalid');

    // The other member's delivery (different email) is untouched.
    expect(untouched?.recipient_email_lower).toBe(otherEmail);
  });

  it('matches case-insensitively: a mixed-case email set tombstones a lower-cased delivery', async () => {
    // recipient_email_lower is always lower-cased by the webhook, but a
    // member's contact email is case-PRESERVED in storage (the unique index is
    // on lower(email)). The repo MUST lower-case the email set before matching,
    // else a Mixed.Case@example.com contact would never match its own
    // mixed-case-stored-but-lower-delivered row (PII survival).
    const localPart = `mixed-case-${randomUUID().slice(0, 8)}`;
    const storedEmail = `${localPart}@Example.COM`; // as a contact stores it
    const deliveredLower = `${localPart}@example.com`; // as the webhook stored it
    const deliveryId = await seedDelivery(deliveredLower);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, [storedEmail]),
    );
    expect(result.tombstonedCount).toBeGreaterThanOrEqual(1);

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT recipient_email_lower
        FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
      `)) as unknown as Array<{ recipient_email_lower: string }>;
      return rows[0];
    });
    expect(row?.recipient_email_lower).toMatch(/^erased\+/);
  });

  it('empty email set → no UPDATE, tombstonedCount 0 (short-circuit)', async () => {
    // A member with no live-contact / linked-login emails yields an empty set.
    // The repo must short-circuit (no rows can match) rather than run an
    // `= ANY('{}')` UPDATE that touches nothing — guards against a malformed
    // empty-array predicate accidentally matching every row.
    const presentEmail = `present-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(presentEmail);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, []),
    );
    expect(result.tombstonedCount).toBe(0);

    // The present delivery is NOT touched by an empty-set call.
    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT recipient_email_lower
        FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
      `)) as unknown as Array<{ recipient_email_lower: string }>;
      return rows[0];
    });
    expect(row?.recipient_email_lower).toBe(presentEmail);
  });

  it('re-drive is a clean no-op: an already-tombstoned row is not re-matched', async () => {
    // The sentinel recipient_email_lower (erased+<id>@erased.invalid) is never
    // in a member's real email set, so a second tombstone pass over the same
    // email set matches 0 rows — a US2d reconciler re-drive is idempotent.
    const email = `redrive-${randomUUID().slice(0, 8)}@example.com`;
    await seedDelivery(email);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const first = await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, [email]),
    );
    expect(first.tombstonedCount).toBeGreaterThanOrEqual(1);

    const second = await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, [email]),
    );
    expect(second.tombstonedCount).toBe(0);
  });

  it('scrubs error_message PII (raw bounce diagnostics embed the recipient email)', async () => {
    // Resend bounce strings are persisted UNSANITIZED from the webhook and
    // routinely embed the recipient email (e.g. SMTP `550 5.1.1 <addr> …`).
    // After the tombstone the erased member's email must NOT survive as
    // plaintext anywhere — including error_message (GDPR Art.17 / PDPA §33).
    const victimEmail = `victim-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(victimEmail, {
      errorMessage: `550 5.1.1 <${victimEmail}> recipient rejected`,
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.tombstoneDeliveriesForMemberInTx(tx, tenant.ctx.slug, [victimEmail]),
    );

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT recipient_email_lower, error_message
        FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug}
          AND delivery_id = ${deliveryId}
      `)) as unknown as Array<{
        recipient_email_lower: string;
        error_message: string | null;
      }>;
      return rows[0];
    });

    // Recipient email tombstoned to the sentinel …
    expect(row?.recipient_email_lower).toMatch(/^erased\+/);
    // … and the raw bounce diagnostic no longer leaks the plaintext email.
    expect(row?.error_message ?? '').not.toContain(victimEmail);
  });

  /**
   * Drizzle wraps the Postgres trigger exception so a top-level
   * `rejects.toThrow` does not match. Walk the `cause` chain with
   * `errorChainMessage` and substring-assert the RAISE EXCEPTION text.
   * Mirrors the helper in `redaction-guc-trigger.test.ts`.
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
      throw new Error(
        'Expected trigger to raise but the statement succeeded silently',
      );
    }
    const chain = errorChainMessage(caught);
    if (!pattern.test(chain)) {
      throw new Error(`Expected ${pattern} in cause chain but got: ${chain}`);
    }
  }

  it('0225 guardrail: DELETE stays blocked even under app.allow_broadcast_redaction', async () => {
    // The GUC arm relaxes UPDATE only — a DELETE under the GUC must stay
    // blocked (broadcast_deliveries rows are insert-only audit trail; the
    // tombstone RETAINS rows for record-of-processing).
    //
    // DEFENCE-IN-DEPTH NOTE: under `runInTenant` the role is `chamber_app`,
    // which migration 0065 granted only SELECT,INSERT and 0225 widened with
    // UPDATE — NEVER DELETE. So a chamber_app DELETE is blocked at the TABLE-
    // PRIVILEGE layer (`permission denied for table broadcast_deliveries`)
    // BEFORE the `broadcast_deliveries_append_only_fn` trigger's DELETE arm
    // is ever reached. The trigger's DELETE RAISE is a second, independent
    // guard (it would fire for an owner role that holds DELETE). Either way
    // the DELETE is rejected — assert the block, accepting either reason.
    const email = `delete-guard-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(email);

    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            DELETE FROM broadcast_deliveries
            WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
          `);
        }),
      /broadcast_deliveries_append_only|permission denied for table broadcast_deliveries/,
    );

    // The row is still present (DELETE was blocked).
    const stillThere = await runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT delivery_id FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
      `)) as unknown as Array<{ delivery_id: string }>;
      return rows.length;
    });
    expect(stillThere).toBe(1);
  });

  it('0225 guardrail: a non-PII column change under the GUC RAISEs (status is not redactable)', async () => {
    // Under the GUC ONLY recipient_member_id/recipient_email_lower/error_message
    // may change. A change to a non-PII column (status) must RAISE so the
    // exemption cannot be abused to rewrite the delivery audit trail.
    const email = `status-guard-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(email); // status seeded 'delivered'

    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            UPDATE broadcast_deliveries SET status = 'bounced'
            WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
          `);
        }),
      /broadcast_deliveries_redaction_only_pii_cols/,
    );
  });

  it('0225 guardrail: a non-PII delivery-metadata change under the GUC RAISEs (bounce_type is not redactable)', async () => {
    // Second non-PII column in the 0225 blocklist (migration 0225 line 87):
    // `bounce_type` is append-only delivery metadata ('hard' | 'soft', FR-027
    // routing) — NOT recipient PII. Like `status`, a change to it under the
    // GUC must RAISE, so the redaction exemption can ONLY rewrite the three
    // recipient-PII columns and can never be abused to rewrite the load-bearing
    // append-only audit metadata. `bounce_type` is seeded NULL by seedDelivery,
    // so `SET bounce_type = 'hard'` is IS DISTINCT FROM OLD → the trigger fires.
    const email = `bounce-guard-${randomUUID().slice(0, 8)}@example.com`;
    const deliveryId = await seedDelivery(email); // bounce_type seeded NULL

    await expectRaiseInChain(
      () =>
        runInTenant(tenant.ctx, async (tx) => {
          await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
          await tx.execute(sql`
            UPDATE broadcast_deliveries SET bounce_type = 'hard'
            WHERE tenant_id = ${tenant.ctx.slug} AND delivery_id = ${deliveryId}
          `);
        }),
      /broadcast_deliveries_redaction_only_pii_cols/,
    );
  });

  it("redacts the erased member email out of ANOTHER author's custom_recipient_emails (element-wise; sibling recipients preserved)", async () => {
    // COMP-1 FIX-9: the AUTHOR scrub (scrubContentForMemberInTx) keys on
    // requested_by_member_id — it only touches the rows the erased member
    // AUTHORED. The erased member's email sitting in a DIFFERENT (sibling)
    // author's custom_recipient_emails text[] is never reached by that scrub,
    // so the erased subject's plaintext PII survives on the sibling's row
    // (Art.17 / PDPA §33 gap). redactMemberEmailFromCustomRecipientsInTx
    // element-wise redacts the erased member's email out of EVERY author's
    // custom rows tenant-wide, keyed on EMAIL (case-insensitive), preserving the
    // sibling author's OTHER legitimate recipients.
    const victimEmail = `fix9-victim-${randomUUID().slice(0, 8)}@example.com`;
    const siblingMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: siblingMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Sibling Author',
        country: 'TH',
        planId,
        planYear: 2026,
      });
    });
    // A custom broadcast authored by the SIBLING (NOT the erased member) whose
    // recipient list includes the erased member's email + a peer to preserve.
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'custom',
      owner: siblingMemberId,
      customEmails: [victimEmail, 'sibling-keep@x.com'],
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.redactMemberEmailFromCustomRecipientsInTx(tx, tenant.ctx.slug, [
        victimEmail,
      ]),
    );
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ custom: broadcasts.customRecipientEmails })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    // Element-wise: the victim element → '[redacted]', the sibling's OTHER
    // recipient preserved, order preserved.
    expect(row?.custom).toEqual(['[redacted]', 'sibling-keep@x.com']);
  });

  it('matches the custom-recipient email case-insensitively (mixed-case stored, lower-cased erasure set)', async () => {
    // A custom_recipient_emails element is case-PRESERVED in storage (the
    // sibling author typed it as the member spelled it), but the erasure set is
    // sourced from the member's contact emails (also case-preserved) and lowered
    // by the repo. The element-wise CASE must lower-case BOTH sides, else a
    // Mixed.Case stored element never matches its lower-cased erasure key → PII
    // survival.
    const localPart = `fix9-mixed-${randomUUID().slice(0, 8)}`;
    const storedMixed = `${localPart}@Example.COM`; // sibling's list element
    const erasureLower = `${localPart}@example.com`; // lowered erasure key
    const siblingMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: siblingMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Sibling Mixed',
        country: 'TH',
        planId,
        planYear: 2026,
      });
    });
    const broadcastId = await seedBroadcast({
      status: 'submitted',
      segment: 'custom',
      owner: siblingMemberId,
      customEmails: [storedMixed, 'keep-mixed@x.com'],
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const result = await runInTenant(tenant.ctx, (tx) =>
      repo.redactMemberEmailFromCustomRecipientsInTx(tx, tenant.ctx.slug, [
        erasureLower,
      ]),
    );
    expect(result.redactedCount).toBeGreaterThanOrEqual(1);

    const row = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ custom: broadcasts.customRecipientEmails })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0];
    });
    expect(row?.custom).toEqual(['[redacted]', 'keep-mixed@x.com']);
  });

  it('re-drive is a clean no-op: a second pass over an already-redacted list returns redactedCount 0 (CHANGED-rows)', async () => {
    // The redactedCount reflects rows CHANGED (the EXISTS guard excludes rows
    // whose elements are all already redacted / no longer match), so a US2d
    // reconciler re-drive over the same email set matches 0 rows — idempotent,
    // no DUPLICATE audit churn.
    const victimEmail = `fix9-redrive-${randomUUID().slice(0, 8)}@example.com`;
    const siblingMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: siblingMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Sibling Redrive',
        country: 'TH',
        planId,
        planYear: 2026,
      });
    });
    await seedBroadcast({
      status: 'submitted',
      segment: 'custom',
      owner: siblingMemberId,
      customEmails: [victimEmail, 'redrive-keep@x.com'],
    });
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    const first = await runInTenant(tenant.ctx, (tx) =>
      repo.redactMemberEmailFromCustomRecipientsInTx(tx, tenant.ctx.slug, [
        victimEmail,
      ]),
    );
    expect(first.redactedCount).toBeGreaterThanOrEqual(1);

    const second = await runInTenant(tenant.ctx, (tx) =>
      repo.redactMemberEmailFromCustomRecipientsInTx(tx, tenant.ctx.slug, [
        victimEmail,
      ]),
    );
    expect(second.redactedCount).toBe(0);
  });

  it('empty email set → no UPDATE, redactedCount 0 (short-circuit)', async () => {
    const result = await runInTenant(tenant.ctx, (tx) =>
      repoForEmpty().redactMemberEmailFromCustomRecipientsInTx(
        tx,
        tenant.ctx.slug,
        [],
      ),
    );
    expect(result.redactedCount).toBe(0);
  });

  function repoForEmpty() {
    return makeDrizzleBroadcastsRepo(tenant.ctx.slug);
  }
});
