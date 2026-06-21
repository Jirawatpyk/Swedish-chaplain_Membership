/**
 * COMP-1 US3-B — credit_notes PII-redaction GUC arm (live Neon Singapore).
 *
 * `credit_notes` is born issued (no draft phase) — its immutability trigger
 * (`credit_notes_enforce_immutability`, migration 0027) locks every snapshot /
 * money / pdf column from INSERT. The 10-year member-invoice retention sweeper
 * (`/api/cron/invoicing/redact-expired-member-invoices`) must tombstone the
 * buyer PII held in `credit_notes.member_identity_snapshot` once the §87/3
 * statutory tax-retention hold lifts — but that column is locked, so a naive
 * redaction UPDATE is BLOCKED.
 *
 * Migration 0227 adds the SAME GUC arm the invoices trigger gained in
 * 0205/0206: under `SET LOCAL app.allow_pii_redaction = 'true'` ONLY
 * `member_identity_snapshot` + the new `pii_blob_purged_at` marker may change;
 * EVERY other column (money / numbering / pdf / the §86/10 money-FK
 * `source_refund_id`) still RAISEs; the normal path (GUC unset) locks
 * everything INCLUDING the marker.
 *
 * These cases pin the trigger contract:
 *   1. UNDER the GUC, redacting member_identity_snapshot + stamping
 *      pii_blob_purged_at SUCCEEDS.
 *   2. UNDER the GUC, a money/numbering column change RAISEs (PII + marker only).
 *   3. WITHOUT the GUC, a member_identity_snapshot change RAISEs (normal path
 *      still locks it).
 *   4. UNDER the GUC, a source_refund_id change RAISEs (the §86/10 money-FK,
 *      migration 0038, is NOT in the 2-col exemption — thai-tax + security
 *      plan review).
 *   5. The function retains its `search_path = pg_catalog, public` hardening
 *      after CREATE OR REPLACE (the migration-0124 gotcha).
 *
 * Migrations through 0227 MUST be applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
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
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

/** A complete buyer PII snapshot as pinned at issue on a member credit note. */
const BUYER = {
  legal_name: 'CN Redact Co Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@cn-redact.example',
} as const;

describe('credit_notes PII-redaction GUC arm (COMP-1 US3-B, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /**
   * Seed a tenant-scoped issued credit note with a real buyer snapshot, plus
   * the membership plan / member / settings / parent invoice rows its FKs
   * require. Returns the fresh credit_note_id (each case seeds its own row so
   * a RAISEing case never poisons a later one).
   */
  async function seedCreditNote(): Promise<{ tenant: TestTenant; creditNoteId: string }> {
    const creditNoteId = randomUUID();
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    const planId = `cn-guc-plan-${randomUUID().slice(0, 8)}`;
    const seq = Math.floor(Math.random() * 2_000_000) + 1;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'CN GUC Plan' },
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
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'CN GUC Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });

      // tenant_invoice_settings is keyed by tenant_id only — seed once.
      await tx
        .insert(tenantInvoiceSettings)
        .values({
          tenantId: tenant.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 0n,
          legalNameTh: 'ทดสอบ',
          legalNameEn: 'Test',
          taxId: '0000000000000',
          registeredAddressTh: 'Bangkok',
          registeredAddressEn: 'Bangkok',
          invoiceNumberPrefix: 'CN-G',
          creditNoteNumberPrefix: 'CN-GC',
        })
        .onConflictDoNothing();

      // Parent invoice to satisfy the FK on credit_notes.original_invoice_id.
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
      });

      await tx.insert(creditNotes).values({
        tenantId: tenant.ctx.slug,
        creditNoteId,
        originalInvoiceId: invoiceId,
        fiscalYear: 2026,
        sequenceNumber: seq,
        documentNumber: `CN-GC26-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-01-15',
        issuedByUserId: user.userId,
        reason: 'US3-B GUC fixture',
        creditAmountSatang: 100000n,
        vatSatang: 7000n,
        totalSatang: 107000n,
        tenantIdentitySnapshot: {
          legal_name_en: 'Test',
          legal_name_th: 'ทดสอบ',
          tax_id: '0000000000000',
          address: 'Bangkok',
        },
        memberIdentitySnapshot: BUYER,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/cn_${seq}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });

    return { tenant, creditNoteId };
  }

  /**
   * Run `fn` and return the flattened error-message chain, or null if it did
   * NOT throw. Drizzle 0.45+ wraps the Postgres error as `Failed query: …` and
   * nests the trigger's `RAISE EXCEPTION` text on `.cause` — so a plain
   * `rejects.toThrow(/…/)` (which only matches the TOP-level `.message`) would
   * miss the trigger message. We walk the `.cause` chain (mirroring the existing
   * credit-note-immutability spec) so the assertion sees the trigger text.
   */
  async function captureRaise(fn: () => Promise<unknown>): Promise<string | null> {
    let caught: unknown = null;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    if (caught === null) return null;
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.length > 0 ? parts.join(' | ') : String(caught);
  }

  it('UNDER the GUC, redacting member_identity_snapshot + stamping pii_blob_purged_at SUCCEEDS', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      await tx.execute(sql`
        UPDATE credit_notes
        SET member_identity_snapshot = member_identity_snapshot
              || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                   'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL),
            pii_blob_purged_at = now()
        WHERE credit_note_id = ${creditNoteId}
      `);
    });
    const rows = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT member_identity_snapshot->>'legal_name' AS ln, pii_blob_purged_at FROM credit_notes WHERE credit_note_id = ${creditNoteId}`),
    )) as unknown as Array<{ ln: string; pii_blob_purged_at: Date | null }>;
    expect(rows[0]?.ln).toBe('[REDACTED]');
    expect(rows[0]?.pii_blob_purged_at).not.toBeNull();
  }, 30_000);

  it('UNDER the GUC, changing a MONEY/numbering column RAISEs (only PII + marker exempt)', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    const msg = await captureRaise(() =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(sql`UPDATE credit_notes SET total_satang = 1 WHERE credit_note_id = ${creditNoteId}`);
      }),
    );
    expect(msg, 'expected the GUC per-field check to raise on a money change').not.toBeNull();
    expect(msg!).toMatch(/immutable|only member_identity_snapshot/i);
  }, 30_000);

  it('WITHOUT the GUC, changing member_identity_snapshot RAISEs (normal path still locks it)', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    const msg = await captureRaise(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`UPDATE credit_notes SET member_identity_snapshot = '{}'::jsonb WHERE credit_note_id = ${creditNoteId}`),
      ),
    );
    expect(msg, 'expected the normal-path immutability trigger to raise').not.toBeNull();
    expect(msg!).toMatch(/immutable/i);
  }, 30_000);

  it('UNDER the GUC, changing source_refund_id RAISEs (the money-FK is NOT in the 2-col exemption)', async () => {
    // thai-tax + security plan review: source_refund_id (mig 0038, post-0027) is a
    // §86/10 money-linkage FK and MUST stay locked even under the redaction GUC.
    const { tenant, creditNoteId } = await seedCreditNote();
    const msg = await captureRaise(() =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(sql`UPDATE credit_notes SET source_refund_id = '00000000-0000-0000-0000-000000000000' WHERE credit_note_id = ${creditNoteId}`);
      }),
    );
    expect(msg, 'expected the GUC per-field check to raise on a source_refund_id change').not.toBeNull();
    expect(msg!).toMatch(/immutable|only member_identity_snapshot/i);
  }, 30_000);

  it('the immutability function retains its search_path hardening after CREATE OR REPLACE', async () => {
    // The 0124 gotcha: CREATE OR REPLACE resets per-function proconfig. Gate the
    // inline `SET search_path` in CI, not just a manual psql check (drizzle review S1).
    const rows = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`SELECT proconfig FROM pg_proc WHERE proname = 'credit_notes_enforce_immutability'`),
    )) as unknown as Array<{ proconfig: string[] | null }>;
    expect(rows[0]?.proconfig ?? []).toContain('search_path=pg_catalog, public');
  }, 30_000);
});
