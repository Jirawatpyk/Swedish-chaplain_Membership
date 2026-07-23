/**
 * M1 (plan-change-ux, Option 1b) — `credit_notes.retains_coverage` immutability.
 *
 * `retains_coverage` (migration 0272) is a WRITE-ONCE money signal set ONLY by
 * `issueCreditNote` at INSERT; it drives the renewal effective-paid coverage
 * predicate (retract vs RETAIN a fully-credited period). The append-only
 * immutability trigger `credit_notes_enforce_immutability` is an
 * ALLOW-LIST-BY-OMISSION guard — a column not in its lock list is silently
 * MUTABLE. Migration 0273 adds `retains_coverage` to the lock list in BOTH the
 * normal branch AND the GUC-exempt redaction branch (parity with
 * `source_refund_id` / `pii_blob_purged_at`, migration 0227).
 *
 * These cases pin the 0273 contract:
 *   1. NORMAL path (GUC unset) — flipping retains_coverage RAISEs check_violation.
 *   2. UNDER `SET LOCAL app.allow_pii_redaction='true'` — flipping
 *      retains_coverage STILL RAISEs (it is NOT in the 2-col redaction exemption).
 *   3. REGRESSION — the redaction cron's real UPDATE (member_identity_snapshot +
 *      pii_blob_purged_at ONLY, retains_coverage untouched) STILL PASSES under the
 *      GUC (OLD = NEW on retains_coverage → no RAISE).
 *   4. The function retains its `search_path = pg_catalog, public` hardening after
 *      the 0273 CREATE OR REPLACE (the migration-0124 gotcha).
 *
 * Migrations through 0273 MUST be applied first (`pnpm db:migrate`).
 * Live Neon (DEV branch). One tenant.
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
  legal_name: 'CN Coverage Co Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@cn-coverage.example',
} as const;

describe('credit_notes.retains_coverage immutability (M1 migration 0273, live Neon)', () => {
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
   * Seed a tenant-scoped issued credit note (retains_coverage = TRUE at INSERT,
   * a write-once value the trigger must now freeze) plus the membership plan /
   * member / settings / parent invoice rows its FKs require. Each case seeds its
   * own row so a RAISEing case never poisons a later one.
   */
  async function seedCreditNote(): Promise<{ tenant: TestTenant; creditNoteId: string }> {
    const creditNoteId = randomUUID();
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    const planId = `cn-cov-plan-${randomUUID().slice(0, 8)}`;
    const seq = Math.floor(Math.random() * 2_000_000) + 1;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'CN Coverage Plan' },
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
        companyName: 'CN Coverage Co',
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
          invoiceNumberPrefix: 'CN-V',
          creditNoteNumberPrefix: 'CN-VC',
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
        documentNumber: `CN-VC26-${String(seq).padStart(6, '0')}`,
        issueDate: '2026-01-15',
        issuedByUserId: user.userId,
        reason: 'M1 retains_coverage fixture',
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
        // Write-once TRUE — an F4-manual full-membership 'keep' retention note.
        retainsCoverage: true,
      });
    });

    return { tenant, creditNoteId };
  }

  /**
   * Run `fn` and return the flattened error-message chain, or null if it did NOT
   * throw. Drizzle 0.45+ wraps the Postgres error as `Failed query: …` and nests
   * the trigger's `RAISE EXCEPTION` text on `.cause` — so we walk the `.cause`
   * chain (mirroring the credit-note-immutability + redaction-guc specs) so the
   * assertion sees the trigger text.
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

  it('NORMAL path (GUC unset) — flipping retains_coverage RAISEs', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    const msg = await captureRaise(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(
          sql`UPDATE credit_notes SET retains_coverage = NOT retains_coverage WHERE credit_note_id = ${creditNoteId}`,
        ),
      ),
    );
    expect(msg, 'expected the normal-path immutability trigger to raise on a retains_coverage flip').not.toBeNull();
    expect(msg!).toMatch(/immutable/i);
  }, 30_000);

  it('UNDER the redaction GUC — flipping retains_coverage STILL RAISEs (not in the 2-col exemption)', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    const msg = await captureRaise(() =>
      runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
        await tx.execute(
          sql`UPDATE credit_notes SET retains_coverage = NOT retains_coverage WHERE credit_note_id = ${creditNoteId}`,
        );
      }),
    );
    expect(msg, 'expected the GUC per-field check to raise on a retains_coverage flip').not.toBeNull();
    expect(msg!).toMatch(/immutable|only member_identity_snapshot/i);
  }, 30_000);

  it('REGRESSION — the redaction cron UPDATE (member_identity_snapshot + pii_blob_purged_at only) STILL passes', async () => {
    const { tenant, creditNoteId } = await seedCreditNote();
    // Exactly the columns the 10-year retention sweeper touches — retains_coverage
    // is untouched, so OLD = NEW on it → the new 0273 clause does not trip.
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
      tx.execute(
        sql`SELECT member_identity_snapshot->>'legal_name' AS ln, pii_blob_purged_at, retains_coverage FROM credit_notes WHERE credit_note_id = ${creditNoteId}`,
      ),
    )) as unknown as Array<{ ln: string; pii_blob_purged_at: Date | null; retains_coverage: boolean }>;
    expect(rows[0]?.ln).toBe('[REDACTED]');
    expect(rows[0]?.pii_blob_purged_at).not.toBeNull();
    // The write-once coverage signal survives the redaction untouched.
    expect(rows[0]?.retains_coverage).toBe(true);
  }, 30_000);

  it('the immutability function retains its search_path hardening after the 0273 CREATE OR REPLACE', async () => {
    const rows = (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(
        sql`SELECT proconfig FROM pg_proc WHERE proname = 'credit_notes_enforce_immutability'`,
      ),
    )) as unknown as Array<{ proconfig: string[] | null }>;
    expect(rows[0]?.proconfig ?? []).toContain('search_path=pg_catalog, public');
  }, 30_000);
});
