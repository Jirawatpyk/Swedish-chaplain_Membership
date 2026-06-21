/**
 * COMP-1 US2b (Task 6, capstone) — end-to-end live-Neon proof that
 * `eraseMember` leaves NO residual plaintext member email / authored content
 * in F7 broadcasts + deliveries (GDPR Art. 17 / PDPA §33; spec §5 F7 row +
 * §10 "no residual plaintext member email/content" oracle).
 *
 * US2b adds the F7 content-scrub cascade: a post-commit, best-effort,
 * idempotent step that (1) redacts the PII a member AUTHORED into every
 * broadcast they originated (subject/body_html/body_source/from_name/
 * reply_to_email → '[redacted]', custom_recipient_emails → ['[redacted]']
 * on custom rows / NULL otherwise — under the migration-0224 GUC arm), and
 * (2) tombstones every `broadcast_deliveries` row that pointed at the erased
 * member (recipient_member_id → NULL, recipient_email_lower →
 * `erased+<delivery_id>@erased.invalid`, error_message PII scrubbed — under
 * the migration-0225 GUC arm). It emits a `broadcast_content_redacted` audit
 * (5y retention) carrying the counts + the erasure `reason`.
 *
 * This test wires the WHOLE chain — the PRODUCTION composition root
 * `buildEraseMemberDeps(ctx.tenant)` (the REAL `f7BroadcastsContentScrubAdapter`
 * → real `scrubBroadcastContentForMember` → real repo
 * `scrubContentForMemberInTx` + `tombstoneDeliveriesForMemberInTx` + the F7
 * audit emit, alongside the REAL F7/F8 cancel + F1 user-erasure cascades) —
 * against live Neon, on a member who ORIGINATED broadcasts AND received a
 * delivery. The member has NO linked F1 login and NO in-flight broadcast /
 * renewal cycle, so the F1/F7-cancel/F8 cascades return clean-with-zero and
 * the F7 CONTENT-scrub cascade is the subject under test (cascadesComplete
 * stays true on its own success).
 *
 * Oracle (spec §5 F7 + §10):
 *   1. Broadcast content redacted: subject/body_html/body_source/from_name/
 *      reply_to_email = '[redacted]'; non-custom custom_recipient_emails NULL,
 *      custom-row custom_recipient_emails = ['[redacted]'].
 *   2. Delivery tombstoned: recipient_member_id NULL; recipient_email_lower
 *      matches /^erased\+/; error_message no longer embeds the victim email.
 *   3. NO residual plaintext member email/content (§10): a serialized dump of
 *      ALL seeded broadcasts + deliveries rows contains none of the distinctive
 *      plaintext strings ('victim@example.com', 'Volvo Q3 secret', 'm@example.com').
 *   4. Audits: a `broadcast_content_redacted` row (counts + reason:
 *      'gdpr_erasure_request' in the payload — proving the legal basis threaded
 *      through) AND a `member_erased` row (completion proof — proving
 *      cascadesComplete held). Neither summary carries PII.
 *   5. Result: `eraseMember` returned cascadesComplete: true.
 *
 * The cascade already exists (Tasks 1-5) so this capstone passes on first green
 * — correct for a verification oracle. A confirm-can-fail (expect `subject` to
 * still equal the original) was run and observed RED, then restored.
 *
 * Reuses the live-Neon harness shared by `erase-member-f1-user.test.ts`
 * (production `buildEraseMemberDeps` + fee/plan + renewal-policy seed +
 * BYPASSRLS raw select) and the broadcast/delivery seed pattern from
 * `tests/integration/broadcasts/scrub-content-for-member.test.ts`. No mocks —
 * the production builder + real cascades are the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

// ---- Distinctive plaintext PII the erasure MUST eliminate -------------------

const SECRET_SUBJECT = 'Volvo Q3 secret'; // authored broadcast subject
const SECRET_BODY_HTML = '<p>Volvo Q3 secret body — internal numbers</p>';
const SECRET_BODY_SOURCE = 'Volvo Q3 secret body — internal numbers';
const SECRET_FROM_NAME = 'Volvo Q3 Secret Sender';
const SECRET_REPLY_TO = 'q3-secret@volvo.example.com';
const CUSTOM_RECIPIENT_EMAIL = 'm@example.com'; // custom_recipient_emails entry

// ---- Distinctive plaintext a SECOND member B authored — MUST survive --------
// (proves the content-scrub / delivery-tombstone WHERE-clause is member-scoped:
//  a regression that broadened it to hit OTHER members' rows would scrub these).
const B_KEEP_SUBJECT = 'B keep this'; // B's authored broadcast subject
const B_KEEP_BODY_HTML = '<p>B keep this body — B internal</p>';
const B_KEEP_BODY_SOURCE = 'B keep this body — B internal';
const B_KEEP_FROM_NAME = 'B Keep Sender';
const B_KEEP_REPLY_TO = 'b-keep@example.com';

const PLAN_ID = 'test-erase-f7-content-plan';

async function seedPlan(tenant: TestTenant, userId: string) {
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
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Erase F7 Content Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      createdBy: userId,
      updatedBy: userId,
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
}

/**
 * Seed a member M (rich PII) + a primary contact (NO linked F1 user — so the
 * F1 user-erasure cascade is a clean no-op and the F7 content scrub is the
 * subject under test). NO in-flight F7 broadcast / F8 cycle.
 *
 * Returns the contact's email so the caller can seed a delivery row in the
 * PRODUCTION shape (recipient_member_id NULL, recipient_email_lower = this
 * contact email) — the address-keyed correlation the tombstone now uses.
 */
async function seedMember(
  tenant: TestTenant,
): Promise<{ memberId: string; contactId: string; contactEmail: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  // Lower-cased to match recipient_email_lower exactly; the live-contact email
  // captured by eraseMember is the address set the tombstone matches on.
  const contactEmail = `erik-f7-${randomUUID().slice(0, 8)}@example.com`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `F7 Erase Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Erik',
      lastName: 'Eriksson',
      email: contactEmail,
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1980-01-01',
      linkedUserId: null,
      removedAt: null,
    });
  });
  return { memberId, contactId, contactEmail };
}

/**
 * Seed a broadcast authored by `memberId` at `status`. The distinctive PII
 * (subject/body/from_name/reply_to) goes on the `all_members` broadcast; the
 * `custom` broadcast carries `custom_recipient_emails = [CUSTOM_RECIPIENT_EMAIL]`
 * (the cap CHECK requires a 1–100 array on custom rows).
 */
async function seedBroadcast(
  tenant: TestTenant,
  memberId: string,
  planId: string,
  submittedByUserId: string,
  opts: {
    segment: 'all_members' | 'custom';
    subject: string;
    // Content overrides (default to the SECRET_* victim PII so member M's seed
    // is unchanged). Member B passes its own distinctive keep-strings so the
    // post-erasure "untouched" assertions are meaningful, not vacuous.
    bodyHtml?: string;
    bodySource?: string;
    fromName?: string;
    replyToEmail?: string;
    customRecipientEmail?: string;
  },
): Promise<string> {
  const broadcastId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: planId,
      submittedByUserId,
      actorRole: 'member_self_service',
      subject: opts.subject,
      bodyHtml: opts.bodyHtml ?? SECRET_BODY_HTML,
      bodySource: opts.bodySource ?? SECRET_BODY_SOURCE,
      fromName: opts.fromName ?? SECRET_FROM_NAME,
      replyToEmail: opts.replyToEmail ?? SECRET_REPLY_TO,
      segmentType: opts.segment,
      segmentParams: null,
      customRecipientEmails:
        opts.segment === 'custom'
          ? [opts.customRecipientEmail ?? CUSTOM_RECIPIENT_EMAIL]
          : null,
      estimatedRecipientCount: 100,
      status: 'submitted',
      submittedAt: new Date(),
    }),
  );
  return broadcastId;
}

/**
 * COMP-1 FIX-3 — seed an ADDITIONAL contact for an existing member, at the
 * given `removedAt` state. Used to seed a contact ARCHIVED *before* erasure
 * (its identity is scrubbed by the erasure but its historical recipient PII
 * was NEVER redacted by the live-only delivery-tombstone email set), plus a
 * LIVE peer contact at a colliding email. A removed contact MUST carry
 * `is_primary = false` (the `contacts_primary_not_removed` CHECK + the
 * one-primary partial index); a live non-primary contact is fine.
 */
async function seedExtraContact(
  tenant: TestTenant,
  memberId: string,
  email: string,
  opts: { removedAt: Date | null },
): Promise<string> {
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Extra',
      lastName: 'Contact',
      email,
      phone: '+66800000000',
      roleTitle: 'Staff',
      preferredLanguage: 'en',
      isPrimary: false,
      dateOfBirth: '1985-05-05',
      linkedUserId: null,
      removedAt: opts.removedAt,
    }),
  );
  return contactId;
}

/**
 * Seed a delivery row at `recipientEmail` in the PRODUCTION shape:
 * `recipient_member_id = NULL` (the Resend webhook is the only inserter and
 * hard-codes null — it never resolves the recipient to a member). The delivery
 * is correlated to its member ONLY by `recipient_email_lower`, which is the
 * axis the tombstone now matches on. `withBounce` seeds a raw bounce
 * diagnostic embedding the email (member M's residual the tombstone must also
 * scrub); a clean `delivered` row (B's) omits it.
 */
async function seedDelivery(
  tenant: TestTenant,
  recipientEmail: string,
  opts?: { withBounce?: boolean },
): Promise<string> {
  const deliveryId = randomUUID();
  const withBounce = opts?.withBounce ?? false;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcastDeliveries).values({
      tenantId: tenant.ctx.slug,
      deliveryId,
      broadcastId: randomUUID(),
      recipientEmailLower: recipientEmail,
      // PRODUCTION shape: recipient_member_id is NEVER populated in prod (the
      // webhook hard-codes null at process-webhook-event.ts:173,221). Seeding
      // it (the old masking pattern) tested a value production never writes,
      // hiding the tombstone no-op. The correlation is the email.
      recipientMemberId: null,
      status: withBounce ? 'bounced' : 'delivered',
      eventTimestamp: new Date(),
      resendEventId: `evt-${randomUUID()}`,
      resendMessageId: `msg-${randomUUID()}`,
      // Raw bounce diagnostic embeds the recipient email — the residual the
      // tombstone must also scrub (spec §10 oracle). Only on the victim row.
      ...(withBounce && {
        errorMessage: `550 5.1.1 <${recipientEmail}> recipient rejected`,
      }),
    }),
  );
  return deliveryId;
}

// ---- Raw (BYPASSRLS) reads -------------------------------------------------

/** Full broadcast rows for the seeded ids (serialised for the §10 dump oracle). */
async function rawSelectBroadcasts(broadcastIds: readonly string[]) {
  return db
    .select()
    .from(broadcasts)
    .where(inArray(broadcasts.broadcastId, [...broadcastIds]));
}

/** Full delivery rows for the seeded ids (serialised for the §10 dump oracle). */
async function rawSelectDeliveries(deliveryIds: readonly string[]) {
  return db
    .select()
    .from(broadcastDeliveries)
    .where(inArray(broadcastDeliveries.deliveryId, [...deliveryIds]));
}

/** `broadcast_content_redacted` audit rows for this tenant whose payload.member_id matches. */
async function rawSelectContentRedactedAudits(
  tenantSlug: string,
  memberId: string,
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'broadcast_content_redacted'),
      ),
    );
  return rows.filter(
    (r) =>
      (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

/** `member_erased` audit rows for this tenant whose payload.member_id matches. */
async function rawSelectMemberErasedAudits(tenantSlug: string, memberId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'member_erased'),
      ),
    );
  return rows.filter(
    (r) =>
      (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — no residual plaintext member email/content in F7 broadcasts + deliveries (COMP-1 US2b, live Neon, production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // The production builder wires the REAL F8 cascade (makeRenewalsDeps) — seed
    // the renewal policies/settings fixture so that composition root is
    // well-formed even though no in-flight cycle exists for this member.
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('redacts authored broadcast content + tombstones deliveries, emits broadcast_content_redacted + member_erased, completes — leaving no plaintext PII', async () => {
    const { memberId, contactEmail } = await seedMember(tenant);

    // Two broadcasts originated by M: a non-custom one carrying the distinctive
    // content PII, and a custom one carrying the custom-recipient email.
    const nonCustomBroadcastId = await seedBroadcast(
      tenant,
      memberId,
      PLAN_ID,
      admin.userId,
      { segment: 'all_members', subject: SECRET_SUBJECT },
    );
    const customBroadcastId = await seedBroadcast(
      tenant,
      memberId,
      PLAN_ID,
      admin.userId,
      { segment: 'custom', subject: SECRET_SUBJECT },
    );
    const broadcastIds = [nonCustomBroadcastId, customBroadcastId];

    // A delivery M received, in the PRODUCTION shape: recipient_member_id NULL,
    // recipient_email_lower = M's OWN contact email (the only correlation to
    // the member) + a bounce diagnostic embedding it. The eraseMember cascade
    // captures M's live-contact emails pre-scrub and tombstones by THAT set.
    const deliveryId = await seedDelivery(tenant, contactEmail, {
      withBounce: true,
    });

    // Sanity: BEFORE erasure the plaintext PII is present (so the absence
    // assertions below are meaningful, not vacuously true). The member's
    // contact email IS the delivery recipient + embedded in the bounce string.
    const before = JSON.stringify([
      ...(await rawSelectBroadcasts(broadcastIds)),
      ...(await rawSelectDeliveries([deliveryId])),
    ]);
    expect(before).toContain(SECRET_SUBJECT);
    expect(before).toContain(contactEmail);
    expect(before).toContain(CUSTOM_RECIPIENT_EMAIL);

    // PRODUCTION composition root — REAL F1/F7-cancel/F8 + REAL F7 content-scrub
    // cascade. The erasure `reason` (Art.17) threads straight through to the
    // F7 content-scrub audit payload.
    const requestId = `rq-erase-f7-content-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );

    // 5. cascadesComplete — every cascade clean (no in-flight F7/F8 + no linked
    //    login → ok-zero; F7 content-scrub succeeded) → member_erased emitted.
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // 1. Broadcast content redacted on EVERY broadcast M originated.
    const broadcastRows = await rawSelectBroadcasts(broadcastIds);
    expect(broadcastRows).toHaveLength(2);
    for (const row of broadcastRows) {
      expect(row.subject).toBe('[redacted]');
      expect(row.bodyHtml).toBe('[redacted]');
      expect(row.bodySource).toBe('[redacted]');
      expect(row.fromName).toBe('[redacted]');
      expect(row.replyToEmail).toBe('[redacted]');
    }
    const nonCustomRow = broadcastRows.find(
      (r) => r.broadcastId === nonCustomBroadcastId,
    );
    const customRow = broadcastRows.find(
      (r) => r.broadcastId === customBroadcastId,
    );
    // Non-custom row → custom_recipient_emails NULL; custom row → 1-element
    // ['[redacted]'] sentinel array (cap CHECK forbids NULL on custom rows).
    expect(nonCustomRow?.customRecipientEmails).toBeNull();
    expect(customRow?.customRecipientEmails).toEqual(['[redacted]']);

    // 2. Delivery tombstoned: recipient_email_lower (which WAS M's contact
    //    email) sentinelised, error_message no longer embeds it. recipient_
    //    member_id stays NULL (it was always NULL in the production shape; the
    //    tombstone's defensive `SET recipient_member_id = NULL` is a no-op here).
    const deliveryRows = await rawSelectDeliveries([deliveryId]);
    expect(deliveryRows).toHaveLength(1);
    const delivery = deliveryRows[0]!;
    expect(delivery.recipientMemberId).toBeNull();
    expect(delivery.recipientEmailLower).toMatch(/^erased\+/);
    expect(delivery.recipientEmailLower).toContain('@erased.invalid');
    expect(delivery.errorMessage ?? '').not.toContain(contactEmail);

    // 3. §10 oracle — NO residual plaintext member email/content anywhere in
    //    the dump of ALL the member's broadcasts + deliveries rows. The
    //    member's contact email (which the delivery was keyed on) is the
    //    distinctive recipient PII that MUST be gone.
    const dump = JSON.stringify([...broadcastRows, ...deliveryRows]);
    expect(dump).not.toContain(contactEmail);
    expect(dump).not.toContain(SECRET_SUBJECT);
    expect(dump).not.toContain(SECRET_BODY_SOURCE);
    expect(dump).not.toContain(SECRET_FROM_NAME);
    expect(dump).not.toContain(SECRET_REPLY_TO);
    expect(dump).not.toContain(CUSTOM_RECIPIENT_EMAIL);

    // 4. Audits — broadcast_content_redacted (counts + reason threaded) +
    //    member_erased (completion proof). Neither summary carries PII.
    const redactedAudits = await rawSelectContentRedactedAudits(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      redactedAudits.length,
      'expected a broadcast_content_redacted audit for the erased member',
    ).toBeGreaterThanOrEqual(1);
    const redacted = redactedAudits[0]!;
    const redactedPayload = redacted.payload as {
      scrubbed_count?: number;
      tombstoned_count?: number;
      reason?: string;
    };
    // The legal basis threaded through eraseMember → adapter → use-case.
    expect(redactedPayload.reason).toBe('gdpr_erasure_request');
    expect(redactedPayload.scrubbed_count).toBeGreaterThanOrEqual(2);
    expect(redactedPayload.tombstoned_count).toBeGreaterThanOrEqual(1);
    // No PII in the audit row (summary is `… member=<uuid>` only).
    expect(redacted.summary ?? '').not.toContain(contactEmail);
    expect(redacted.summary ?? '').not.toContain(SECRET_SUBJECT);
    expect(JSON.stringify(redacted)).not.toContain(contactEmail);
    expect(JSON.stringify(redacted)).not.toContain(SECRET_SUBJECT);

    const memberErasedAudits = await rawSelectMemberErasedAudits(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      memberErasedAudits.length,
      'expected the member_erased completion-proof audit (cascadesComplete held)',
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('is member-scoped: erasing member M leaves a co-tenant member B rows UNTOUCHED', async () => {
    // The capstone above seeds only ONE member, so a regression that broadened
    // the content-scrub / delivery-tombstone WHERE-clause to also hit OTHER
    // members' rows would still pass green. This focused test closes that gap:
    // seed a SECOND member B in the SAME tenant with its own broadcast +
    // delivery, erase M, then assert B's rows survive. A WHERE-broadening
    // regression (dropping `requested_by_member_id = $m` on content / matching
    // a too-broad email set on the tombstone) would scrub B too -> RED.
    const { memberId: erasedMemberId, contactEmail: erasedContactEmail } =
      await seedMember(tenant);
    const { memberId: keepMemberId, contactEmail: keepContactEmail } =
      await seedMember(tenant);
    expect(keepMemberId).not.toBe(erasedMemberId);
    expect(keepContactEmail).not.toBe(erasedContactEmail);

    // M (to be erased) originates a broadcast carrying victim PII + a delivery
    // keyed on M's OWN contact email (production shape: recipient_member_id NULL).
    const erasedBroadcastId = await seedBroadcast(
      tenant,
      erasedMemberId,
      PLAN_ID,
      admin.userId,
      { segment: 'all_members', subject: SECRET_SUBJECT },
    );
    await seedDelivery(tenant, erasedContactEmail, { withBounce: true });

    // B (must survive) originates its own broadcast with DISTINCTIVE keep-PII
    // and receives its own delivery keyed on B's OWN contact email — a DISTINCT
    // address that is NOT in M's captured email set, so M's erasure must leave
    // it untouched.
    const keepBroadcastId = await seedBroadcast(
      tenant,
      keepMemberId,
      PLAN_ID,
      admin.userId,
      {
        segment: 'all_members',
        subject: B_KEEP_SUBJECT,
        bodyHtml: B_KEEP_BODY_HTML,
        bodySource: B_KEEP_BODY_SOURCE,
        fromName: B_KEEP_FROM_NAME,
        replyToEmail: B_KEEP_REPLY_TO,
      },
    );
    const keepDeliveryId = await seedDelivery(tenant, keepContactEmail);

    // Sanity: B's keep-PII is present BEFORE erasure (so the untouched
    // assertions below are meaningful, not vacuously true).
    const beforeKeep = JSON.stringify([
      ...(await rawSelectBroadcasts([keepBroadcastId])),
      ...(await rawSelectDeliveries([keepDeliveryId])),
    ]);
    expect(beforeKeep).toContain(B_KEEP_SUBJECT);
    expect(beforeKeep).toContain(keepContactEmail);

    // Erase ONLY member M via the production composition root.
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(erasedMemberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      {
        actorUserId: admin.userId,
        requestId: `rq-erase-f7-content-iso-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // M's own broadcast WAS scrubbed (proves the cascade fired on the target).
    const [erasedBroadcastRow] = await rawSelectBroadcasts([erasedBroadcastId]);
    expect(erasedBroadcastRow?.subject).toBe('[redacted]');

    // --- B's broadcast is UNTOUCHED ---------------------------------------
    const keepBroadcastRows = await rawSelectBroadcasts([keepBroadcastId]);
    expect(keepBroadcastRows).toHaveLength(1);
    const keepBroadcast = keepBroadcastRows[0]!;
    expect(keepBroadcast.subject).toBe(B_KEEP_SUBJECT); // NOT '[redacted]'
    expect(keepBroadcast.bodyHtml).toBe(B_KEEP_BODY_HTML);
    expect(keepBroadcast.bodySource).toBe(B_KEEP_BODY_SOURCE);
    expect(keepBroadcast.fromName).toBe(B_KEEP_FROM_NAME);
    expect(keepBroadcast.replyToEmail).toBe(B_KEEP_REPLY_TO);
    expect(keepBroadcast.requestedByMemberId).toBe(keepMemberId);

    // --- B's delivery is UNTOUCHED ----------------------------------------
    // recipient_member_id was NULL on both deliveries (production shape) — the
    // discriminator is recipient_email_lower: B's must still be B's contact
    // email, NOT the erased+ sentinel (M's erasure matched only M's email set).
    const keepDeliveryRows = await rawSelectDeliveries([keepDeliveryId]);
    expect(keepDeliveryRows).toHaveLength(1);
    const keepDelivery = keepDeliveryRows[0]!;
    expect(keepDelivery.recipientEmailLower).toBe(keepContactEmail); // NOT erased+ sentinel
    expect(keepDelivery.recipientEmailLower).not.toMatch(/^erased\+/);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // COMP-1 US2b /code-review #4 — a re-drive of a SUCCESSFULLY-erased member
  // must NOT emit a SECOND broadcast_content_redacted audit. Before the fix,
  // the content scrub counted rows MATCHED (not CHANGED), so a re-drive
  // re-matched the already-'[redacted]' rows (scrubbedCount >= 1) → the
  // use-case zero-work guard never fired → a DUPLICATE audit on EVERY re-drive.
  // After the fix the scrub filters on `subject <> '[redacted]'` so a re-drive
  // yields scrubbedCount = 0 (and the re-drive tombstone yields 0 — the
  // contacts are removed_at-stamped so the live-email set is empty), the
  // zero-work guard fires, and no second audit is written.
  // ---------------------------------------------------------------------------
  it('re-drive of a fully-erased member emits NO duplicate broadcast_content_redacted audit (#4 changed-rows count)', async () => {
    const { memberId } = await seedMember(tenant);
    await seedBroadcast(tenant, memberId, PLAN_ID, admin.userId, {
      segment: 'all_members',
      subject: SECRET_SUBJECT,
    });

    const deps = buildEraseMemberDeps(tenant.ctx);

    // PASS 1 — clean erasure: one broadcast_content_redacted audit emitted.
    const pass1 = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-nodup-1-${Date.now()}` },
      deps,
    );
    expect(pass1.ok, JSON.stringify(pass1)).toBe(true);
    if (!pass1.ok) return;
    expect(pass1.value.cascadesComplete).toBe(true);
    expect(
      (await rawSelectContentRedactedAudits(tenant.ctx.slug, memberId)).length,
      'pass 1 must write exactly one broadcast_content_redacted audit',
    ).toBe(1);

    // PASS 2 — re-drive of the already-erased + already-scrubbed member. The
    // content scrub changes 0 rows and the tombstone matches 0 (empty live
    // email set), so the zero-work guard fires and NO second audit is written.
    const pass2 = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-nodup-2-${Date.now()}` },
      deps,
    );
    expect(pass2.ok, JSON.stringify(pass2)).toBe(true);
    if (!pass2.ok) return;
    // The re-drive still completes (idempotent), but emits no extra content audit.
    expect(pass2.value.cascadesComplete).toBe(true);
    expect(
      (await rawSelectContentRedactedAudits(tenant.ctx.slug, memberId)).length,
      're-drive must NOT emit a second broadcast_content_redacted audit',
    ).toBe(1);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // COMP-1 US2b — re-drive stability after a first-pass F7-cascade FAILURE.
  //
  // THE BUG (2026-06-18 2nd /code-review, HIGH): the delivery tombstone keyed on
  // the member's email set, which eraseMember rebuilt from LIVE sources. On a
  // RE-DRIVE (reconciler / manual, after a first-pass content-scrub failure) the
  // contacts are already removed_at-stamped, so listLiveEmailsForMemberInTx
  // returns [] -> a POST-COMMIT email-keyed tombstone matched 0 rows. But the
  // CONTENT scrub (keyed on requested_by_member_id, never scrubbed) still
  // succeeded -> allCascadesClean stayed true -> member_erased emitted -> the
  // delivery's plaintext recipient_email_lower + email-bearing error_message
  // SURVIVED forever, silently.
  //
  // THE FIX (ATOMIC MOVE): the delivery tombstone now runs INSIDE the atomic
  // members-scrub tx (while the member's emails are still live), co-committing
  // with erased_at. So even when the POST-COMMIT content-scrub fails on pass 1,
  // the delivery is ALREADY tombstoned (the atomic tx committed) -- there is no
  // "erased but deliveries not tombstoned" window. The re-drive then only has to
  // finish the content scrub.
  //
  // CONFIRM-CAN-FAIL: with the OLD post-commit-tombstone code, pass-1's
  // content-scrub failure would roll the tombstone back (it lived in the same F7
  // post-commit step) -> the delivery keeps its plaintext email -> the section
  // 10 dump RED. We force the pass-1 failure by overriding the production
  // broadcastsContentScrub dep with a stub that returns outcome:'failed' on the
  // FIRST pass and uses the real adapter on the re-drive.
  it('re-drive after a first-pass F7-cascade failure leaves NO residual: delivery tombstoned ATOMICALLY on pass 1, content scrub completes on pass 2', async () => {
    const { memberId, contactEmail } = await seedMember(tenant);

    // M originates a broadcast carrying victim PII + receives a delivery keyed
    // on M's OWN contact email (production shape: recipient_member_id NULL) with
    // a bounce diagnostic embedding it.
    const broadcastId = await seedBroadcast(
      tenant,
      memberId,
      PLAN_ID,
      admin.userId,
      { segment: 'all_members', subject: SECRET_SUBJECT },
    );
    const deliveryId = await seedDelivery(tenant, contactEmail, {
      withBounce: true,
    });

    // Sanity: BEFORE erasure the plaintext PII is present.
    const before = JSON.stringify([
      ...(await rawSelectBroadcasts([broadcastId])),
      ...(await rawSelectDeliveries([deliveryId])),
    ]);
    expect(before).toContain(contactEmail);
    expect(before).toContain(SECRET_SUBJECT);

    // ---- PASS 1: force the POST-COMMIT content-scrub cascade to fail --------
    // Production deps, but with the F7 content-scrub dep overridden to return
    // outcome:'failed'. The atomic members-scrub tx (incl. the delivery
    // tombstone) still commits; only the post-commit content cascade fails ->
    // member_erased is WITHHELD.
    const realDeps = buildEraseMemberDeps(tenant.ctx);
    let contentScrubCalls = 0;
    const pass1Deps = {
      ...realDeps,
      broadcastsContentScrub: {
        async scrubContentForMember() {
          contentScrubCalls += 1;
          return { outcome: 'failed' as const };
        },
      },
    };
    const pass1 = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      {
        actorUserId: admin.userId,
        requestId: `rq-erase-f7-redrive-1-${Date.now()}`,
      },
      pass1Deps,
    );
    expect(pass1.ok, JSON.stringify(pass1)).toBe(true);
    if (!pass1.ok) return;
    // The content cascade failed -> completion proof WITHHELD.
    expect(pass1.value.cascadesComplete).toBe(false);
    expect(contentScrubCalls).toBe(1);
    expect(
      (await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId)).length,
      'member_erased must be WITHHELD while a cascade is incomplete',
    ).toBe(0);

    // KEYSTONE: despite the post-commit failure, the delivery is ALREADY
    // tombstoned because the tombstone ran in the COMMITTED atomic members-scrub
    // tx. recipient_email_lower -> erased+ sentinel; error_message no longer
    // embeds the victim email. (With the OLD post-commit-tombstone code this row
    // would still hold the plaintext email here -- the residual the section 10
    // oracle catches.)
    const afterPass1 = await rawSelectDeliveries([deliveryId]);
    expect(afterPass1).toHaveLength(1);
    const delivery1 = afterPass1[0]!;
    expect(delivery1.recipientEmailLower).toMatch(/^erased\+/);
    expect(delivery1.recipientEmailLower).toContain('@erased.invalid');
    expect(delivery1.errorMessage ?? '').not.toContain(contactEmail);

    // ---- RE-DRIVE (PASS 2): real deps; the content scrub now completes ------
    // The member is alreadyErased + the contacts are removed_at-stamped, so
    // listLiveEmailsForMemberInTx returns [] (the very condition that made the
    // OLD post-commit email-keyed tombstone a no-op). The content scrub (keyed
    // on requested_by_member_id) re-discovers + redacts the broadcast, and the
    // delivery was already tombstoned on pass 1, so there is no residual.
    const pass2 = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      {
        actorUserId: admin.userId,
        requestId: `rq-erase-f7-redrive-2-${Date.now()}`,
      },
      realDeps,
    );
    expect(pass2.ok, JSON.stringify(pass2)).toBe(true);
    if (!pass2.ok) return;
    expect(pass2.value.cascadesComplete).toBe(true);

    // Content redacted on the broadcast (re-drive content scrub completed).
    const [broadcastRow] = await rawSelectBroadcasts([broadcastId]);
    expect(broadcastRow?.subject).toBe('[redacted]');

    // member_erased now emitted (completion proof on the clean re-drive).
    expect(
      (await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId)).length,
    ).toBeGreaterThanOrEqual(1);

    // Section 10 oracle -- NO residual plaintext member email/content anywhere.
    const finalDump = JSON.stringify([
      ...(await rawSelectBroadcasts([broadcastId])),
      ...(await rawSelectDeliveries([deliveryId])),
    ]);
    expect(finalDump).not.toContain(contactEmail);
    expect(finalDump).not.toContain(SECRET_SUBJECT);
    expect(finalDump).not.toContain(SECRET_BODY_SOURCE);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // COMP-1 FIX-3 — a contact ARCHIVED before erasure must have its historical
  // recipient PII redacted too (its identity IS scrubbed), WITHOUT redacting a
  // PEER member's live delivery at a colliding email.
  //
  // THE GAP: the delivery tombstone (+ audience derivation + cross-author
  // custom-recipient redaction) keyed on `listLiveEmailsForMemberInTx` (live
  // contacts only). A contact archived BEFORE erasure (removed_at already set)
  // is therefore NOT in that set, so its historical `broadcast_deliveries`
  // recipient_email_lower survives in plaintext — even though the contact's
  // identity row IS scrubbed by scrubPiiForMemberInTx (which redacts ALL
  // contacts regardless of removed_at). Art.17/§33 plaintext-PII survival.
  //
  // THE OVER-FIX TRAP: a blanket "use ALL contact emails" set would also
  // tombstone a PEER member's live delivery at a colliding email — the partial
  // contacts_tenant_email_uniq index (WHERE removed_at IS NULL) permits an
  // email X to be simultaneously (erased member, REMOVED contact) AND (peer
  // member, LIVE contact). So the corrected `tombstoneEmails` set = ALL of the
  // erased member's contact emails MINUS any email currently held by a LIVE
  // contact of a DIFFERENT member.
  //
  // ORACLE (erasing M):
  //   (gap-closure) M's archived-contact delivery to a NON-peer-claimed email
  //     IS tombstoned (recipient_email_lower → erased+ sentinel);
  //   (NO over-fix) a delivery at an email that is BOTH M-archived AND P-live
  //     is NOT tombstoned (still the peer's plaintext address — the collision
  //     residual; deleting/redacting a peer's data is worse than a residual
  //     self-datum, the SAME accepted safer-failure as the live-only outbox
  //     guard).
  //
  // RED on HEAD: M's archived-contact delivery is NOT tombstoned (live-only
  // set excludes it). GREEN after FIX-3. The collision assertion guards the
  // over-fix in BOTH the pre- and post-fix world (it must always stay green).
  it('FIX-3: tombstones a pre-archived contact delivery WITHOUT touching a peer delivery at a colliding email', async () => {
    // Member M: a LIVE primary contact + (below) two ARCHIVED contacts.
    const { memberId, contactEmail: liveEmail } = await seedMember(tenant);

    // M-archived contact with NO peer — its delivery MUST be tombstoned
    // (gap-closure). Distinctive so the dump oracle is meaningful.
    const archivedNoPeerEmail = `m-only-archived-${randomUUID().slice(0, 8)}@example.com`;
    await seedExtraContact(tenant, memberId, archivedNoPeerEmail, {
      removedAt: new Date(),
    });

    // Peer member P with a LIVE contact at the COLLISION email — and M holds an
    // ARCHIVED contact at the SAME email. The partial unique index permits this
    // (M's row is removed_at-stamped, so only P's live row occupies the index).
    const collisionEmail = `collide-${randomUUID().slice(0, 8)}@example.com`;
    const { memberId: peerMemberId } = await seedMember(tenant);
    // P's LIVE contact at the collision email (non-primary, removed_at NULL).
    await seedExtraContact(tenant, peerMemberId, collisionEmail, {
      removedAt: null,
    });
    // M's ARCHIVED contact at the SAME collision email (removed_at set).
    await seedExtraContact(tenant, memberId, collisionEmail, {
      removedAt: new Date(),
    });

    // Deliveries (production shape: recipient_member_id NULL, correlate by email).
    const liveDeliveryId = await seedDelivery(tenant, liveEmail);
    const archivedNoPeerDeliveryId = await seedDelivery(
      tenant,
      archivedNoPeerEmail,
    );
    // A delivery at the collision email — this is the PEER-claimed address;
    // erasing M must NOT tombstone it.
    const collisionDeliveryId = await seedDelivery(tenant, collisionEmail);

    // Sanity: all three plaintext recipient emails present before erasure.
    const before = JSON.stringify(
      await rawSelectDeliveries([
        liveDeliveryId,
        archivedNoPeerDeliveryId,
        collisionDeliveryId,
      ]),
    );
    expect(before).toContain(liveEmail);
    expect(before).toContain(archivedNoPeerEmail);
    expect(before).toContain(collisionEmail);

    // Erase ONLY member M via the production composition root.
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      {
        actorUserId: admin.userId,
        requestId: `rq-erase-fix3-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    const [liveDelivery] = await rawSelectDeliveries([liveDeliveryId]);
    const [archivedNoPeerDelivery] = await rawSelectDeliveries([
      archivedNoPeerDeliveryId,
    ]);
    const [collisionDelivery] = await rawSelectDeliveries([collisionDeliveryId]);

    // gap-closure (1): M's LIVE-contact delivery tombstoned (baseline behaviour).
    expect(liveDelivery?.recipientEmailLower).toMatch(/^erased\+/);

    // gap-closure (2): M's ARCHIVED-contact (no peer) delivery IS tombstoned.
    //   RED on HEAD — the live-only email set excludes the archived contact.
    expect(
      archivedNoPeerDelivery?.recipientEmailLower,
      'a delivery to a contact ARCHIVED before erasure must still be tombstoned',
    ).toMatch(/^erased\+/);

    // NO over-fix: the collision-email delivery (peer P's live address) is
    //   NOT tombstoned — still the peer's plaintext address. Guards the
    //   over-fix; must stay green in BOTH worlds.
    expect(
      collisionDelivery?.recipientEmailLower,
      'a delivery at an email a peer member still holds LIVE must NOT be tombstoned',
    ).toBe(collisionEmail);
    expect(collisionDelivery?.recipientEmailLower).not.toMatch(/^erased\+/);
  }, 120_000);
});
