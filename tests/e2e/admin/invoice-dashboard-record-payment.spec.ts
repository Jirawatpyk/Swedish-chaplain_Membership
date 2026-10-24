/**
 * Spec 124 follow-up — Record payment from the invoice dashboard, end to end,
 * and the touch targets on a tablet.
 *
 *   1. US1.7 / D-o: an admin records a payment on the Oldest overdue card's
 *      first row → the success toast, the row leaves the card, the Overdue
 *      tile drops by one, focus lands on the next row's Record payment…, and
 *      the invoice is `paid` with a receipt number.
 *   2. US6.2 on a tablet: under `(pointer: coarse)` at 1024 × 768 the
 *      document-number link and the footer link are each at least 44 px tall.
 *
 * Recording a payment issues a §87 receipt number, so this runs ONLY on a
 * throwaway tenant (never the shared e2e tenant): it needs
 * `E2E_X_TENANT_HEADER_ENABLED=1` on the server, which CI never sets — run it
 * against a branch server, as `invoice-pay.spec.ts`. The page is behind
 * FEATURE_INVOICE_DASHBOARD; with the flag off the tests skip.
 */
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Page } from '@playwright/test';
import en from '@/i18n/messages/en.json';
import { db, runInTenant } from '@/lib/db';
import { bangkokTodayIso } from '@/lib/bangkok-today';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { expect, test } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { createThrowawayTenant, type ThrowawayTenant } from '../helpers/throwaway-tenant';

const D = en.admin.invoiceDashboard;
const P = en.admin.invoices.pay;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;

function daysBefore(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function adminUserId(): Promise<string> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
  if (rows.length === 0) throw new Error('e2e: no admin user seeded');
  return rows[0]!.id;
}

/** Two issued 088 bills, due 40 and 30 days ago, on a throwaway tenant. */
async function seedOverdueBills(): Promise<{ tenant: ThrowawayTenant; oldest: string; next: string }> {
  const tenant = await createThrowawayTenant({ seedSettings: true, seedMember: true, seedPlan: true });
  const today = bangkokTodayIso();
  const draftBy = await adminUserId();
  const ids = { oldest: randomUUID(), next: randomUUID() };
  await runInTenant(tenant.ctx, async (tx) => {
    for (const [invoiceId, dueDays] of [
      [ids.oldest, 40],
      [ids.next, 30],
    ] as const) {
      await tx.insert(invoices).values({
        tenantId: tenant.slug,
        invoiceId,
        memberId: tenant.memberId!,
        planYear: 2026,
        planId: 'regular',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: draftBy,
        autoEmailOnIssue: false,
        // 088 new-flow bill (as renewals/rolling-anchor.spec.ts): no §87
        // number until the receipt mints at payment.
        fiscalYear: 2026,
        sequenceNumber: null,
        documentNumber: null,
        billDocumentNumberRaw: `E2E-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: daysBefore(today, 45),
        dueDate: daysBefore(today, dueDays),
        currency: 'THB',
        subtotalSatang: 1_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 70_000n,
        totalSatang: 1_070_000n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: {
          legal_name_th: 'หอการค้าทดสอบ',
          legal_name_en: 'E2E Test Chamber',
          tax_id: '0000000000000',
          address_th: '1 ถนนทดสอบ กรุงเทพฯ 10110',
          address_en: '1 Test Road, Bangkok 10110',
          logo_blob_key: null,
        } as unknown,
        memberIdentitySnapshot: {
          legal_name: `Dashboard Pay E2E ${dueDays}d Ltd`,
          tax_id: null,
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Dashboard Tester',
          primary_contact_email: `dashboard-pay-${randomUUID().slice(0, 8)}@example.com`,
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
    }
  });
  return { tenant, ...ids };
}

/** Opens the dashboard; skips when the flag is off on this server. */
async function openDashboard(page: Page): Promise<void> {
  const response = await page.goto('/admin/finance', { waitUntil: 'domcontentloaded' });
  test.skip(response?.status() === 404, 'FEATURE_INVOICE_DASHBOARD is off on this server');
  await expect(page.getByRole('heading', { level: 1, name: D.title })).toBeVisible();
}

/** The Overdue tile's count, read from its caption ("N past due · as of today"). */
async function overdueTileCount(page: Page): Promise<number> {
  const caption = page.getByTestId('dashboard-tiles').getByText(/past due · as of today/);
  await expect(caption).toBeVisible();
  return Number((await caption.innerText()).replace(/[^\d]/g, ''));
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('124 — Record payment from the dashboard (throwaway tenant)', () => {
  test.skip(!ADMIN_EMAIL, 'Set E2E_ADMIN_* (seeded by scripts/seed-e2e-user.ts)');
  test.skip(
    process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
    'E2E_X_TENANT_HEADER_ENABLED=1 required for the throwaway tenant (a payment burns a §87 number)',
  );

  let seeded: Awaited<ReturnType<typeof seedOverdueBills>>;

  test.beforeEach(async () => {
    await clearE2ERateLimits();
    seeded = await seedOverdueBills();
  });

  test.afterEach(async () => {
    await seeded?.tenant.cleanup().catch((e) => console.error('throwaway cleanup:', e));
  });

  test('1. paying the first row: toast, row gone, tile down one, focus on the next row', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'X-Tenant': seeded.tenant.slug });
    await signInAsAdmin(page);
    await openDashboard(page);

    const before = await overdueTileCount(page);
    expect(before).toBe(2);
    const rows = page.getByTestId('oldest-overdue-row');
    await expect(rows).toHaveCount(2);

    // Row 1 is the longest past due: the 40-day bill.
    await page.locator(`#oldest-overdue-pay-${seeded.oldest}`).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Defaults: bank transfer, today (Bangkok).
    await dialog.getByRole('button', { name: P.submit, exact: true }).click();

    await expect(page.locator('.aura-toaster').getByText(/Tax receipt .+ issued|Payment recorded/)).toBeVisible({
      timeout: 45_000,
    });
    await expect(dialog).toBeHidden();
    await expect(rows).toHaveCount(1);
    expect(await overdueTileCount(page)).toBe(before - 1);
    // D-o: focus moves to the next row's Record payment…, never to <body>.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
      .toBe(`oldest-overdue-pay-${seeded.next}`);

    const [paid] = await runInTenant(seeded.tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status, receipt: invoices.receiptDocumentNumberRaw })
        .from(invoices)
        .where(and(eq(invoices.tenantId, seeded.tenant.slug), eq(invoices.invoiceId, seeded.oldest))),
    );
    expect(paid?.status).toBe('paid');
    expect(paid?.receipt).toBeTruthy();
  });

  test('2. tablet (1024 × 768, coarse pointer): the card links are 44 px targets', async ({
    browser,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'one tablet context is enough; chromium only');
    const context = await browser.newContext({
      ...(baseURL ? { baseURL } : {}),
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
      extraHTTPHeaders: { 'X-Tenant': seeded.tenant.slug },
    });
    try {
      const page = await context.newPage();
      await signInAsAdmin(page);
      await openDashboard(page);
      const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      test.skip(!coarse, 'this browser does not report a coarse pointer for a touch context');

      const card = page.getByTestId('oldest-overdue-table');
      const documentLink = card.getByRole('link').first();
      const footerLink = page.getByRole('link', { name: new RegExp(`^${D.oldest.allOverdueNoCount}`) });
      for (const [name, link] of [
        ['document number', documentLink],
        ['All overdue invoices', footerLink],
      ] as const) {
        await expect(link).toBeVisible();
        const box = await link.boundingBox();
        expect(box?.height ?? 0, `${name} link height`).toBeGreaterThanOrEqual(44);
        console.log(`TABLET ${name}: ${Math.round(box!.width)}×${Math.round(box!.height)}`);
      }
    } finally {
      await context.close();
    }
  });
});
