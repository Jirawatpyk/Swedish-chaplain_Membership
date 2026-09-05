/**
 * 108 T011 (US1, FR-001/FR-003) — a resend reaches the LIVE primary contact, and
 * its "no recipient" skip actually lands in the database.
 *
 * Resend is the path where the frozen-address bug bit hardest: it runs longest
 * after issue, so it is the most likely to be asked for precisely because
 * something changed. It is also the one path that runs OUTSIDE a money
 * transaction (`tx === null`), which is why the audit half is worth proving
 * against a real database rather than a spy: the F4 audit adapter's standalone
 * arm writes through the pool client and LOG-AND-SWALLOWS on failure, so a row
 * that never lands would be invisible from inside the use case. If this
 * assertion is ever removed, that path can regress silently.
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
import { resendPdf } from '@/modules/invoicing/application/use-cases/resend-pdf';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeResendPdfDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const FIXED_NOW = '2026-09-30T08:00:00.000Z';

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

function issueDeps(slug: string): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        sha256: Sha256Hex.ofUnsafe('c'.repeat(64)),
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
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
  };
}

describe('108 resend-pdf — live primary contact (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'resend-live-plan';
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
        planName: { en: 'Resend Live Plan' },
        description: { en: '108 resend live-recipient test' },
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
      await db.delete(table).where(eq(table.tenantId, tenant.ctx.slug)).catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(): Promise<{ memberId: string; contactId: string; email: string }> {
    const memberId = randomUUID();
    const contactId = randomUUID();
    const email = `at-issue-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Resend Live Corp',
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

  async function promoteNewPrimary(memberId: string, oldContactId: string): Promise<string> {
    const email = `promoted-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(contacts)
        .set({ isPrimary: false, removedAt: new Date() })
        .where(
          and(eq(contacts.tenantId, tenant.ctx.slug), eq(contacts.contactId, oldContactId)),
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

  async function removeAllContacts(memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(contacts)
        .set({ isPrimary: false, removedAt: new Date() })
        .where(and(eq(contacts.tenantId, tenant.ctx.slug), eq(contacts.memberId, memberId))),
    );
  }

  async function issuedBill(memberId: string): Promise<string> {
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rs-draft-${randomUUID()}`,
      memberId,
      planId,
      planYear,
    });
    if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft)}`);
    const invoiceId = draft.value.invoiceId;
    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `rs-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
    return invoiceId;
  }

  function resend(invoiceId: string) {
    return resendPdf(makeResendPdfDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      kind: 'invoice',
      invoiceId,
      variant: 'invoice',
      actor: {
        userId: user.userId,
        role: 'admin',
        requestId: `rs-resend-${randomUUID()}`,
      },
    });
  }

  async function resentRows(invoiceId: string) {
    return (await db.execute(sql`
      SELECT to_email
        FROM notifications_outbox
       WHERE tenant_id = ${tenant.ctx.slug}
         AND context_data->>'invoice_id' = ${invoiceId}
         AND context_data->>'event_type' = 'invoice_pdf_resent'
    `)) as unknown as Array<{ to_email: string }>;
  }

  it('resend after a promotion goes to the NEW primary contact', async () => {
    const { memberId, contactId, email: atIssue } = await seedMember();
    const invoiceId = await issuedBill(memberId);
    const promoted = await promoteNewPrimary(memberId, contactId);

    const r = await resend(invoiceId);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);

    const rows = await resentRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(promoted);
    expect(rows.map((x) => x.to_email)).not.toContain(atIssue);
  }, 60_000);

  it('no live primary → no_recipient, no outbox row, and the audit row LANDS despite the null tx', async () => {
    const { memberId } = await seedMember();
    const invoiceId = await issuedBill(memberId);
    await removeAllContacts(memberId);

    const r = await resend(invoiceId);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_recipient');
    expect(await resentRows(invoiceId)).toHaveLength(0);

    // The load-bearing assertion. This path has no transaction, so the audit
    // adapter takes its standalone arm — pool client, explicit tenant_id, and a
    // try/catch that logs and swallows. A spy would have said "emit called" for
    // a row that never landed.
    const audit = (await db.execute(sql`
      SELECT payload, retention_years
        FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type = 'auto_email_skipped_no_recipient'
         AND payload->>'invoice_id' = ${invoiceId}
    `)) as unknown as Array<{
      payload: Record<string, unknown>;
      retention_years: number;
    }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.email_event_type).toBe('invoice_pdf_resent');
    expect(audit[0]!.payload.related_member_id).toBe(memberId);
    expect(audit[0]!.retention_years).toBe(10);
  }, 60_000);

  it('a repeated resend after the fix reaches the restored primary', async () => {
    const { memberId } = await seedMember();
    const invoiceId = await issuedBill(memberId);
    await removeAllContacts(memberId);

    const refused = await resend(invoiceId);
    expect(refused.ok).toBe(false);

    // Staff add a contact and promote it — the FR-003 remedy.
    const restored = `restored-${randomUUID().slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Restored',
        lastName: 'Primary',
        email: restored,
        isPrimary: true,
      }),
    );

    const r = await resend(invoiceId);
    expect(r.ok, r.ok ? 'ok' : JSON.stringify(r)).toBe(true);
    const rows = await resentRows(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_email).toBe(restored);
  }, 60_000);
});
