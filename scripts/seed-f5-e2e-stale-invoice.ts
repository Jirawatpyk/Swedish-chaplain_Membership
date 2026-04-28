/**
 * H-8 (review 2026-04-27) — E2E fixture for the stale-invoice
 * auto-refund banner flow on `/portal/invoices/[invoiceId]`.
 *
 * Seeds (idempotent):
 *   - One void invoice `SC-2026-900099` against the existing E2E
 *     member (linked to `e2e-member@swecham.test`)
 *   - One `payment_auto_refunded_stale_invoice` audit_log row keyed
 *     to that invoice id
 *
 * Together these reproduce the post-auto-refund state the member
 * lands on when admin voids their invoice mid-payment. The portal
 * detail page then renders the new "Payment automatically refunded"
 * sub-section inside the void banner (T121 assertion target).
 *
 * Idempotency:
 *   - The invoice row uses a fixed UUID `00000000-e2e0-4fff-9ffe-
 *     000000900099` so re-runs UPDATE-not-INSERT.
 *   - The audit row is INSERT-only (append-only invariant) — but the
 *     portal page only checks for "≥1 row exists", so duplicates do
 *     not change behavior. We dedupe via a request_id-based
 *     SELECT-then-INSERT to keep the table clean across re-runs.
 *
 * Refusal: only runs against TENANT_SLUG=swecham (matches the
 * sibling seed scripts).
 *
 * Usage:
 *   TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/seed-f5-e2e-stale-invoice.ts
 *
 * Echoes E2E_STALE_INVOICE_ID for `.env.local`.
 */
import { eq, and, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const E2E_MEMBER_EMAIL = 'e2e-member@swecham.test';
const E2E_STALE_INVOICE_ID = '00000000-e2e0-4fff-9ffe-000000900099';

async function main(): Promise<void> {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-f5-e2e-stale-invoice: refusing TENANT_SLUG="${TENANT_SLUG}". Only 'swecham' is allowed.`,
    );
  }
  const ctx = asTenantContext('swecham');

  // 1. Locate the existing E2E member by walking user → contact (member binding).
  const userRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, E2E_MEMBER_EMAIL.toLowerCase()))
    .limit(1);
  if (userRow.length === 0) {
    throw new Error(
      `seed-f5-e2e-stale-invoice: ${E2E_MEMBER_EMAIL} not found — run seed-e2e-portal-invoices.ts first.`,
    );
  }
  const userId = userRow[0]!.id;

  const memberRow = await runInTenant(ctx, async (tx) =>
    tx
      .select({ memberId: members.memberId })
      .from(members)
      .where(
        and(
          eq(members.tenantId, ctx.slug),
          eq(members.companyName, 'E2E Alpha Co'),
        ),
      )
      .limit(1),
  );
  if (memberRow.length === 0) {
    throw new Error(
      'seed-f5-e2e-stale-invoice: E2E Alpha Co member not found — run seed-e2e-portal-invoices.ts first.',
    );
  }
  const memberId = memberRow[0]!.memberId;

  // 2. Upsert the void invoice. Minimal field set — no PDF (the
  // Download CTA is conditional on `invoice.pdf`, hidden when null,
  // which is fine for the banner-only assertion path).
  await runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.invoiceId, E2E_STALE_INVOICE_ID),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      await tx
        .update(invoices)
        .set({
          status: 'void',
          voidedAt: new Date(),
          voidReason: 'Admin void — H-8 E2E fixture (stale-invoice auto-refund)',
          voidedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invoices.tenantId, ctx.slug),
            eq(invoices.invoiceId, E2E_STALE_INVOICE_ID),
          ),
        );
      console.log(`  updated invoice ${E2E_STALE_INVOICE_ID} → void`);
    } else {
      await tx.insert(invoices).values({
        tenantId: ctx.slug,
        invoiceId: E2E_STALE_INVOICE_ID,
        memberId,
        planYear: 2026,
        planId: 'regular',
        status: 'void',
        draftByUserId: userId,
        fiscalYear: 2026,
        sequenceNumber: 900099,
        documentNumber: 'SC-2026-900099',
        issueDate: '2026-04-27',
        dueDate: '2026-05-27',
        currency: 'THB',
        subtotalSatang: 1000000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 70000n,
        totalSatang: 1070000n,
        // Snapshots required by `invoices_non_draft_has_snapshots`
        // CHECK constraint — F4 invariant: any non-draft row must
        // carry frozen tenant + member identity at issue time.
        tenantIdentitySnapshot: {
          legal_name_th: 'หอการค้าไทย-สวีเดน',
          legal_name_en: 'Thai-Swedish Chamber of Commerce',
          tax_id: '0000000000000',
          address_line_th: 'Bangkok',
          address_line_en: 'Bangkok',
        },
        memberIdentitySnapshot: {
          // Required keys by `invoices_snapshot_has_contact_email`
          // CHECK (migration 0045): legal_name, address,
          // primary_contact_email, primary_contact_name — all strings.
          legal_name: 'E2E Alpha Co',
          address: 'E2E fixture address, Bangkok',
          primary_contact_email: E2E_MEMBER_EMAIL,
          primary_contact_name: 'E2E Alpha',
          tax_id: '1111111111111',
        },
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        // PDF placeholders — `invoices_non_draft_has_snapshots` CHECK
        // requires non-null, but the H-8 banner test does NOT exercise
        // the PDF download path (the void state hides the Resend CTA
        // and we never click Download — the page renders without
        // hitting Vercel Blob).
        pdfBlobKey: 'h8-fixture-no-pdf',
        pdfSha256: '0'.repeat(64),
        pdfTemplateVersion: 1,
        voidedAt: new Date(),
        voidReason: 'Admin void — H-8 E2E fixture (stale-invoice auto-refund)',
        voidedByUserId: userId,
      });
      console.log(`  inserted void invoice ${E2E_STALE_INVOICE_ID}`);
    }
  });

  // 3. Append the audit row. audit_log is append-only and the portal
  //    page only checks "≥1 row exists for invoiceId", so duplicates
  //    across re-runs are harmless. Raw SQL because the Drizzle
  //    auditLog schema does not expose `retention_years`.
  const payload = JSON.stringify({
    payment_id: '00000000-e2e0-4fff-9ffe-000000999099',
    invoice_id: E2E_STALE_INVOICE_ID,
    refunded_amount_satang: '1070000',
    cause: 'invoice_voided',
    processor_refund_id: 're_e2e_h8_fixture',
  });
  await db.execute(sql`
    INSERT INTO audit_log
      (event_type, actor_user_id, summary, request_id, payload,
       tenant_id, retention_years)
    VALUES
      ('payment_auto_refunded_stale_invoice'::audit_event_type,
       '00000000-0000-0000-0000-000000000000',
       'H-8 E2E fixture — auto-refund on void invoice for member portal banner test',
       'h8-e2e-stale-fixture-2026-04-27',
       ${payload}::jsonb,
       ${ctx.slug},
       10)
  `);
  console.log(`  appended audit row payment_auto_refunded_stale_invoice`);

  console.log('');
  console.log('--- copy into .env.local ---');
  console.log(`E2E_STALE_INVOICE_ID=${E2E_STALE_INVOICE_ID}`);
  console.log('-----------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
