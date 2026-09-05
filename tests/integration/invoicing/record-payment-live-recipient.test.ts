/**
 * 108 T009 (US1, FR-001/FR-003/FR-004) — the receipt email reaches the member's
 * LIVE primary contact, proven end-to-end on live Neon.
 *
 * The unit tests pin the use case against a fake port. This file proves the part
 * a fake cannot: that the real adapter's SQL, running inside the payment
 * transaction under RLS, resolves the contact who is primary NOW — and that the
 * frozen buyer snapshot on the same invoice still names the contact who was
 * primary at issue (§86/4). Both facts, on one row, at the same moment.
 *
 * PDF render + Blob upload are mocked (the harness pattern the sibling
 * record-payment integration tests use); the allocator, repos, outbox, audit,
 * settings and the recipient adapter are all real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const FIXED_NOW = '2026-09-30T08:00:00.000Z';
const PAYMENT_DATE = '2026-09-30';

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

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDeps(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
  };
}

function recordDeps(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockPdfBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
    asyncReceiptPdf: false,
  };
}

describe('108 record-payment — receipt reaches the live primary contact (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'live-recipient-plan';
  const planYear = 2026;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thai-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Live Recipient Plan' },
        description: { en: '108 live-recipient test' },
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
  }, 60_000);

  afterAll(async () => {
    await db
      .execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${tenant.ctx.slug}`)
      .catch(() => {});
    for (const table of [invoices, contacts, members] as const) {
      await db
        .delete(table)
        .where(eq(table.tenantId, tenant.ctx.slug))
        .catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /** Member + one primary contact. Returns ids and the primary's address. */
  async function seedMember(): Promise<{
    memberId: string;
    contactId: string;
    email: string;
  }> {
    const memberId = randomUUID();
    const contactId = randomUUID();
    const email = `at-issue-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Live Recipient Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'At',
        lastName: 'Issue',
        email,
        isPrimary: true,
      });
    });
    return { memberId, contactId, email };
  }

  /**
   * Promote a NEW contact to primary, exactly as the F3 promote path leaves the
   * rows: the old primary is demoted and removed, the new one is live primary.
   */
  async function promoteNewPrimary(memberId: string, oldContactId: string): Promise<string> {
    const email = `promoted-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: false, removedAt: new Date() })
        .where(
          and(
            eq(contacts.tenantId, tenant.ctx.slug),
            eq(contacts.contactId, oldContactId),
          ),
        );
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Promoted',
        lastName: 'Primary',
        email,
        isPrimary: true,
      });
    });
    return email;
  }

  /**
   * The FR-003 "no live primary" state. Since 108 PR-B (migration 0293) an
   * ACTIVE member with contact rows must carry exactly one live primary at
   * COMMIT, so soft-removing every contact is no longer a reachable state —
   * the one no-primary population left is the CONTACT-LESS member (a bare
   * import), which is what these cases now model. Owner-role hard delete:
   * zero rows remain, which 0293 exempts.
   */
  async function removeAllContacts(memberId: string): Promise<void> {
    await db
      .delete(contacts)
      .where(and(eq(contacts.tenantId, tenant.ctx.slug), eq(contacts.memberId, memberId)));
  }

  async function issuedMembershipBill(memberId: string): Promise<string> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `lr-draft-${randomUUID()}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `lr-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
    return invoiceId;
  }

  /**
   * The outbox keys the invoice + F4 event inside `context_data` (the table
   * itself only has `notification_type`), so filter on the jsonb.
   */
  async function outboxFor(invoiceId: string, eventType: string) {
    const rows = (await db.execute(sql`
      SELECT to_email
        FROM notifications_outbox
       WHERE tenant_id = ${tenant.ctx.slug}
         AND context_data->>'invoice_id' = ${invoiceId}
         AND context_data->>'event_type' = ${eventType}
    `)) as unknown as Array<{ to_email: string }>;
    return rows;
  }

  async function skipAuditFor(invoiceId: string) {
    const rows = (await db.execute(sql`
      SELECT payload, retention_years
        FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'auto_email_skipped_no_recipient'
         AND payload->>'invoice_id' = ${invoiceId}
    `)) as unknown as Array<{
      payload: Record<string, unknown>;
      retention_years: number;
    }>;
    return rows;
  }

  function pay(invoiceId: string) {
    return recordPayment(recordDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `lr-pay-${randomUUID()}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
      triggeredBy: 'admin_manual',
    });
  }

  it('promote after issue → the receipt email goes to the NEW primary, and never to the old one', async () => {
    const { memberId, contactId, email: atIssue } = await seedMember();
    const invoiceId = await issuedMembershipBill(memberId);
    const promoted = await promoteNewPrimary(memberId, contactId);

    const r = await pay(invoiceId);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.emailDispatch).toBe('sent');

    const rows = await outboxFor(invoiceId, 'invoice_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(promoted);
    expect(rows.map((x) => x.to_email)).not.toContain(atIssue);
  }, 60_000);

  it('the tax document still names the buyer captured at issue (§86/4 is untouched)', async () => {
    const { memberId, contactId, email: atIssue } = await seedMember();
    const invoiceId = await issuedMembershipBill(memberId);
    const promoted = await promoteNewPrimary(memberId, contactId);

    await pay(invoiceId);

    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    const snapshot = row!.memberIdentitySnapshot as { primary_contact_email: string };
    // Identity is frozen…
    expect(snapshot.primary_contact_email).toBe(atIssue);
    // …while delivery moved. Both true on the same row: that IS the fix.
    const rows = await outboxFor(invoiceId, 'invoice_paid');
    expect(rows[0]!.to_email).toBe(promoted);
  }, 60_000);

  it('no live primary → no outbox row, skipped_no_email, and one audited skip at 5-year retention', async () => {
    const { memberId } = await seedMember();
    const invoiceId = await issuedMembershipBill(memberId);
    await removeAllContacts(memberId);

    const r = await pay(invoiceId);

    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value.emailDispatch).toBe('skipped_no_email');
    expect(await outboxFor(invoiceId, 'invoice_paid')).toHaveLength(0);

    const audit = await skipAuditFor(invoiceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.related_member_id).toBe(memberId);
    expect(audit[0]!.payload.email_event_type).toBe('invoice_paid');
    // 10y — this row records that a tax document was never delivered, and its
    // sibling document events are all 10y. Keeping "sent" longer than "never
    // sent" is an asymmetry that always favours us.
    expect(audit[0]!.retention_years).toBe(10);
    // No address anywhere in the payload — there is none; that IS the event.
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('@');
  }, 60_000);

  it('the skip audit row carries no `member_id` key, so it cannot bump last_activity_at', async () => {
    const { memberId } = await seedMember();
    const invoiceId = await issuedMembershipBill(memberId);
    await removeAllContacts(memberId);

    await pay(invoiceId);

    // Migration 0009's trigger bumps `members.last_activity_at` for ANY audit
    // row whose payload has a snake_case `member_id`, and the member-timeline
    // view selects on the same key. Paying an invoice legitimately bumps it via
    // the `invoice_paid` row — so the assertion has to be about THIS row, not
    // about the column: the skip must not be able to claim member activity for
    // a member whose contact data is broken (exactly whom the at-risk scorer
    // most needs to flag).
    const rows = (await db.execute(sql`
      SELECT (payload ? 'member_id') AS has_member_id
        FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'auto_email_skipped_no_recipient'
         AND payload->>'invoice_id' = ${invoiceId}
    `)) as unknown as Array<{ has_member_id: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.has_member_id).toBe(false);
  }, 60_000);

  it('idempotent replay of a paid invoice reports skipped_no_email once the primary is gone', async () => {
    const { memberId } = await seedMember();
    const invoiceId = await issuedMembershipBill(memberId);

    const first = await pay(invoiceId);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.emailDispatch).toBe('sent');

    await removeAllContacts(memberId);
    const replay = await pay(invoiceId);

    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.emailDispatch).toBe('skipped_no_email');
    // A replay re-sends nothing and audits no NEW skip — the original attempt
    // already owned that decision.
    expect(await outboxFor(invoiceId, 'invoice_paid')).toHaveLength(1);
    expect(await skipAuditFor(invoiceId)).toHaveLength(0);
  }, 60_000);

  it('a bounced, odd-looking primary address is still the ONLY target (FR-001b)', async () => {
    // Deliverability is the dispatcher's problem. Recipient CHOICE is not: a
    // previously-bounced or unusual-looking address must not cause a silent
    // redirect to some other contact, and must not fall back to the snapshot —
    // either would send a member's invoice to someone who never asked for it.
    const memberId = randomUUID();
    // Unusual but VALID: mixed case + a plus-tag. (A genuinely malformed
    // address cannot reach this path at all — the buyer-identity snapshot's
    // zod schema rejects it at ISSUE, long before any receipt.)
    const odd = `Odd.Primary+tag-${randomUUID().slice(0, 8)}@Example.COM`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Bounced Primary Corp',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        planId,
        planYear,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Bounced',
        lastName: 'Primary',
        email: odd,
        isPrimary: true,
        // F3 marks a contact whose portal invitation bounced. It is a warning
        // badge in the directory — never a reason to re-address money mail.
        inviteBouncedAt: new Date(),
      });
      // A perfectly deliverable SECONDARY exists — the tempting wrong answer.
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Healthy',
        lastName: 'Secondary',
        email: `healthy-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: false,
      });
    });
    const invoiceId = await issuedMembershipBill(memberId);

    const r = await pay(invoiceId);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);

    const rows = await outboxFor(invoiceId, 'invoice_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(odd);
  }, 60_000);
});
