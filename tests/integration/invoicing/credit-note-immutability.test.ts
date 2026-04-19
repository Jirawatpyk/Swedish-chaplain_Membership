/**
 * N8 (review 2026-04-19 21:19) — credit_notes immutability trigger
 * behavioral test.
 *
 * Migration 0027_credit_notes_immutability.sql installs a BEFORE
 * UPDATE trigger that rejects any change to snapshot + money + pdf
 * columns. The existing tenant-isolation test verifies
 * `A.update(B credit_note) affects 0 rows` — that's RLS, not the
 * trigger. A bug in the trigger body (wrong column list, stale
 * reference) would silently pass RLS-only tests.
 *
 * This test seeds a credit_note under its owning tenant context and
 * attempts an UPDATE on each immutable column. The expected behaviour
 * is that Postgres raises `check_violation` (SQLSTATE 23514) via the
 * trigger. We assert the error message matches so a future rewrite
 * of the trigger message is caught.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

describe('F4 credit_notes immutability trigger — behavioral (N8)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let creditNoteId: string;
  let invoiceId: string;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    creditNoteId = randomUUID();
    invoiceId = randomUUID();
    memberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'cn-imm-plan',
        planYear: 2026,
        planName: { en: 'CN Imm Plan' },
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
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'CN Imm Co',
        country: 'TH',
        planId: 'cn-imm-plan',
        planYear: 2026,
      });

      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'CN-T',
        creditNoteNumberPrefix: 'CN-TC',
      });

      // An invoice row to satisfy the FK on credit_notes.original_invoice_id.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'cn-imm-plan',
        draftByUserId: user.userId,
      });

      const snapshot = {
        legal_name_en: 'Test',
        legal_name_th: 'ทดสอบ',
        tax_id: '0000000000000',
        address: 'Bangkok',
      };
      await tx.insert(creditNotes).values({
        tenantId: tenant.ctx.slug,
        creditNoteId,
        originalInvoiceId: invoiceId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'CN-TC26-000001',
        issueDate: '2026-01-15',
        issuedByUserId: user.userId,
        reason: 'N8 immutability fixture',
        creditAmountSatang: 100000n,
        vatSatang: 7000n,
        totalSatang: 107000n,
        tenantIdentitySnapshot: snapshot,
        memberIdentitySnapshot: snapshot,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/cn_v1.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  // A representative sample of the 14 immutable columns covered by
  // the trigger. Each attempt MUST raise the trigger's exception —
  // we assert both that the UPDATE throws AND that the message
  // matches the trigger body (so a future rewrite that silently
  // swaps the RAISE EXCEPTION for a WARN is caught).
  const immutableCases = [
    {
      name: 'credit_amount_satang (money)',
      update: async () => {
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(creditNotes)
            .set({ creditAmountSatang: 999999n })
            .where(eq(creditNotes.creditNoteId, creditNoteId)),
        );
      },
    },
    {
      name: 'vat_satang (money)',
      update: async () => {
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(creditNotes)
            .set({ vatSatang: 42n })
            .where(eq(creditNotes.creditNoteId, creditNoteId)),
        );
      },
    },
    {
      name: 'document_number (§87 identity)',
      update: async () => {
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(creditNotes)
            .set({ documentNumber: 'HACKED-001' })
            .where(eq(creditNotes.creditNoteId, creditNoteId)),
        );
      },
    },
    {
      name: 'tenant_identity_snapshot (PII snapshot)',
      update: async () => {
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(creditNotes)
            .set({
              tenantIdentitySnapshot: {
                legal_name_en: 'Mutated',
                legal_name_th: 'แก้ไข',
                tax_id: '1111111111111',
                address: 'Mutated',
              },
            })
            .where(eq(creditNotes.creditNoteId, creditNoteId)),
        );
      },
    },
    {
      name: 'pdf_sha256 (document integrity)',
      update: async () => {
        await runInTenant(tenant.ctx, (tx) =>
          tx
            .update(creditNotes)
            .set({ pdfSha256: 'b'.repeat(64) })
            .where(eq(creditNotes.creditNoteId, creditNoteId)),
        );
      },
    },
  ] as const;

  for (const tc of immutableCases) {
    it(`rejects UPDATE on ${tc.name} within the owning tenant`, async () => {
      let caught: unknown = null;
      try {
        await tc.update();
      } catch (e) {
        caught = e;
      }
      expect(caught, 'expected trigger to raise').not.toBeNull();
      const message =
        caught instanceof Error ? caught.message : String(caught);
      expect(message).toMatch(
        /credit_notes.*immutable|check_violation|snapshot \+ money \+ pdf/i,
      );
    }, 15_000);
  }
});
