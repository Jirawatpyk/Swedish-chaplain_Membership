/**
 * Rolling-anchor E2E (plan Task 12) — the full admin acceptance walk for
 * the renewal-rolling-anchor feature (spec
 * docs/superpowers/specs/2026-07-08-renewal-rolling-anchor-design.md):
 *
 *   1. Admin creates a member via the UI (cold-start listener provisions a
 *      registration-date-anchored cycle).
 *   2. New-invoice form shows the FIRST-PAYMENT renewal-context line
 *      (Task 9) and no duplicate warning; draft creation still works.
 *   3. A payment with a BACKDATED paymentDate lands (record-payment API —
 *      the same rail the admin dialog posts to). The invoice is seeded as
 *      ISSUED with a matching backdated issue_date because record-payment
 *      enforces `issueDate <= paymentDate <= today` — a today-issued
 *      invoice can never take a genuinely backdated payment (the
 *      seeded-issued shape mirrors rolling-anchor-payment.test.ts).
 *   4. The member-detail "Renewal & Health" card shows the period anchored
 *      at the payment MONTH (1st of month → +12 months), NOT the
 *      registration date; DB state is asserted precisely.
 *   5. A second New-invoice visit for the same member shows the
 *      duplicate-billing warning (renewal-classified + period end more
 *      than 6 months out).
 *
 * Runs on a throwaway tenant (X-Tenant header) — requires
 * E2E_X_TENANT_HEADER_ENABLED=1 + the seeded e2e admin.
 */
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { addMonthsUtc } from '@/lib/dates';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { expect, fillField, test } from '../fixtures';
import { createThrowawayTenant } from '../helpers/throwaway-tenant';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.beforeEach(async () => {
  await clearE2ERateLimits();
});

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Exclude /admin/sign-in from the post-login match (F5R6+ regex fix).
  await page.waitForURL(/\/admin(\/(?!sign-in)|$)/, { timeout: 15_000 });
}

/** First day of the ISO instant's UTC month, midnight UTC. */
function monthStartUtc(iso: string): string {
  return `${iso.slice(0, 7)}-01T00:00:00.000Z`;
}

/** invoices.draft_by_user_id is a NOT NULL FK — reuse the seeded e2e admin. */
async function resolveAdminUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (rows.length === 0) throw new Error('e2e: no admin user seeded');
  return rows[0]!.id;
}

test.describe('rolling-anchor admin flow @renewals', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );
  test.skip(
    process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
    'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant',
  );

  test('first payment anchors the cycle at the payment month; second invoice warns', async ({
    page,
  }) => {
    test.setTimeout(240_000); // 5-step chained flow on a dev server

    const tenant = await createThrowawayTenant({
      seedSettings: true,
      seedPlan: true,
      seedMember: false, // the member is created via the UI below
    });
    try {
      await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
      await signInAdmin(page);

      // ── Step 1: admin creates the member via the UI ────────────────────
      await page.goto('/admin/members/new');
      await expect(
        page.getByRole('heading', { name: /add member/i }),
      ).toBeVisible({ timeout: 20_000 });

      const suffix = Date.now().toString(36);
      await fillField(page.locator('#company_name'), `Rolling Anchor E2E ${suffix}`);
      // PR-B task 5 — #country is now a searchable combobox trigger <button>
      // (not a fillable text <input>); no explicit selection needed since
      // the form already defaults it to 'TH' (schema default).
      await page.locator('#plan_id').click();
      await page.getByRole('option').first().click();
      // 065 §5.1 — billing_cycle is a new REQUIRED Select; pick the first option.
      await page.locator('#billing_cycle').click();
      await page.getByRole('option').first().click();
      // 088 §86/4 — a TH member (country defaults to 'TH') now REQUIRES a full
      // buyer address. Fill line 1 + an unambiguous Bangkok postcode (10800 →
      // Bang Sue) whose lookup auto-fills province/city/sub_district; wait for
      // that to land before submit or the schema superRefine blocks the POST.
      await fillField(page.locator('#address_line1'), '99 Test Tower');
      await fillField(page.locator('#postal_code'), '10800');
      await expect(page.locator('#province')).toContainText(/bangkok/i, {
        timeout: 10_000,
      });
      await fillField(page.locator('#first_name'), 'Anchor');
      await fillField(page.locator('#last_name'), 'Tester');
      await fillField(
        page.locator('#contact_email'),
        `rolling-anchor-${suffix}@example.com`,
      );

      const [createResp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/api/members') && r.request().method() === 'POST',
          { timeout: 20_000 },
        ),
        page.getByRole('button', { name: /create member/i }).click(),
      ]);
      expect(createResp.status()).toBe(201);
      await page.waitForURL(/\/admin\/members\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      const memberId = new URL(page.url()).pathname.split('/').pop()!;

      // ── Step 2: New invoice → first-payment context line visible ──────
      const createInvoiceLink = page
        .getByRole('link', { name: /create (new|first) invoice|new invoice/i })
        .first();
      await expect(createInvoiceLink).toBeVisible({ timeout: 20_000 });
      await createInvoiceLink.click();
      await page.waitForURL(/\/admin\/invoices\/new(\?|$)/, { timeout: 20_000 });

      const contextLine = page.getByTestId('renewal-context-line');
      await expect(contextLine).toBeVisible({ timeout: 20_000 });
      // firstPayment copy (spec §3b — also covers the heal_no_cycle
      // grouping, so a slow cold-start cycle listener can't flake this).
      await expect(contextLine).toContainText(/membership period has not started/i);
      await expect(page.getByTestId('renewal-duplicate-warning')).toHaveCount(0);

      // Draft creation still works with the context panel present.
      const submitButton = page.getByRole('button', { name: /create draft/i });
      await expect(submitButton).toBeEnabled({ timeout: 15_000 });
      await submitButton.click();
      await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]{36}$/, { timeout: 20_000 });

      // ── Step 3: backdated payment ──────────────────────────────────────
      // Payment ~2 months ago. record-payment enforces
      // issueDate <= paymentDate <= today, so the payable invoice is
      // seeded ISSUED with issue_date at that month's 1st.
      const nowIso = new Date().toISOString();
      const payMonthStart = monthStartUtc(addMonthsUtc(nowIso, -2));
      const paymentDate = `${payMonthStart.slice(0, 8)}08`; // the 8th
      const issueDate = payMonthStart.slice(0, 10); // the 1st
      const expectedPeriodTo = addMonthsUtc(payMonthStart, 12);

      const invoiceId = randomUUID();
      const adminUserId = await resolveAdminUserId();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(invoices).values({
          tenantId: tenant.slug,
          invoiceId,
          memberId,
          planYear: 2026,
          planId: 'regular',
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: adminUserId,
          autoEmailOnIssue: false,
          // 088 new-flow BILL shape (FEATURE_088_TAX_AT_PAYMENT is ON in
          // dev): non-§87 bill number set; §87 seq/doc NULL until the RC
          // receipt mints at payment. A LEGACY §87-numbered seed would be
          // refused with `legacy_invoice_needs_reissue` (FR-017).
          // fiscal_year stays NOT NULL (DB CHECK — the SC bill stream FY).
          fiscalYear: 2026,
          sequenceNumber: null,
          documentNumber: null,
          billDocumentNumberRaw: `E2E-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
          issueDate,
          dueDate: paymentDate,
          currency: 'THB',
          subtotalSatang: 1_000_000n,
          vatRateSnapshot: '0.0700',
          vatSatang: 70_000n,
          totalSatang: 1_070_000n,
          // MUST be a valid ProRatePolicy ('none'|'monthly'|'daily') — the
          // repo read brands it and an invalid value 500s the /pay route.
          proRatePolicySnapshot: 'none',
          netDaysSnapshot: 30,
          // Snapshots MUST satisfy the read-boundary contracts: the member
          // snapshot is zod-parsed on every repo read (`tax_id` must be
          // PRESENT — nullable but not optional; a missing key throws
          // MalformedSnapshotError → /pay 500s); the tenant snapshot has no
          // zod guard but the §86/4 receipt template renders these exact
          // snake_case fields.
          tenantIdentitySnapshot: {
            legal_name_th: 'หอการค้าทดสอบ',
            legal_name_en: 'E2E Test Chamber',
            tax_id: '0000000000000',
            address_th: '1 ถนนทดสอบ กรุงเทพฯ 10110',
            address_en: '1 Test Road, Bangkok 10110',
            logo_blob_key: null,
          } as unknown,
          memberIdentitySnapshot: {
            legal_name: `Rolling Anchor E2E ${suffix} Ltd`,
            tax_id: null,
            address: '1 Test Road, Bangkok 10110',
            primary_contact_name: 'Anchor Tester',
            primary_contact_email: `rolling-anchor-${suffix}@example.com`,
          } as unknown,
          pdfBlobKey: `invoicing/${tenant.slug}/2026/${invoiceId}.pdf`,
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
        await tx.insert(invoiceLines).values({
          tenantId: tenant.slug,
          invoiceId,
          kind: 'membership_fee',
          descriptionTh: 'ค่าสมาชิกประจำปี 2026',
          descriptionEn: 'Annual fee 2026',
          quantity: '1',
          unitPriceSatang: 1_000_000n,
          totalSatang: 1_000_000n,
          position: 1,
        });
      });

      const payResp = await page.context().request.post(
        `/api/invoices/${invoiceId}/pay`,
        {
          headers: {
            'Content-Type': 'application/json',
            Origin: new URL(page.url()).origin,
            'X-Tenant': tenant.slug,
          },
          data: {
            paymentMethod: 'bank_transfer',
            paymentDate,
            paymentReference: 'E2E-ROLLING-ANCHOR',
            paymentNotes: 'backdated first payment',
          },
        },
      );
      if (!(payResp.status() >= 200 && payResp.status() < 300)) {
        const body = await payResp.text();
        throw new Error(
          `POST /api/invoices/${invoiceId}/pay → ${payResp.status()}: ${body.slice(0, 500)}`,
        );
      }

      // ── Step 4: cycle anchored at the payment MONTH ────────────────────
      const cycles = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.memberId, memberId),
              inArray(renewalCycles.status, ['upcoming', 'reminded', 'awaiting_payment']),
            ),
          ),
      );
      expect(cycles, 'exactly one open cycle after the anchoring payment').toHaveLength(1);
      const cycle = cycles[0]!;
      expect(cycle.periodFrom.toISOString()).toBe(payMonthStart);
      expect(cycle.periodTo.toISOString()).toBe(expectedPeriodTo);
      expect(cycle.anchoredAt, 'cycle is stamped anchored').not.toBeNull();
      expect(cycle.anchorInvoiceId).toBe(invoiceId);

      // Renewal & Health card shows the re-anchored expiry (payment month
      // start + 12 months), not the registration-date expiry.
      await page.goto(`/admin/members/${memberId}`);
      const healthCard = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: /renewal & health/i }) });
      await expect(healthCard).toBeVisible({ timeout: 20_000 });
      const expectedExpiryText = new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
      }).format(new Date(expectedPeriodTo));
      await expect(healthCard).toContainText(expectedExpiryText, { timeout: 20_000 });

      // ── Step 5: second invoice → duplicate warning ─────────────────────
      const secondInvoiceLink = page
        .getByRole('link', { name: /create (new|first) invoice|new invoice/i })
        .first();
      await expect(secondInvoiceLink).toBeVisible({ timeout: 20_000 });
      await secondInvoiceLink.click();
      await page.waitForURL(/\/admin\/invoices\/new(\?|$)/, { timeout: 20_000 });

      const contextLine2 = page.getByTestId('renewal-context-line');
      await expect(contextLine2).toBeVisible({ timeout: 20_000 });
      await expect(contextLine2).toContainText(/current period ends/i);
      // periodTo ≈ 10 months out (> 6-month threshold) → warning shows.
      await expect(page.getByTestId('renewal-duplicate-warning')).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await tenant.cleanup().catch(() => {});
    }
  });
});
