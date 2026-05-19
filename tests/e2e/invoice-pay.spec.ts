/**
 * T068 — E2E: admin records payment + receipt (US2 AS1–AS4).
 *
 * F5R6+ promotion (2026-05-16) — AS1/AS2/AS3 converted from
 * `test.fixme` to real tests using the throwaway-tenant helper +
 * API-issue path (same pattern as invoice-draft-issue.spec.ts).
 */
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { expect, fillField, test } from './fixtures';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog, users } from '@/modules/auth/infrastructure/db/schema';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createThrowawayTenant, type ThrowawayTenant } from './helpers/throwaway-tenant';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

// Reset Upstash auth-rate-limit between tests — prevents mobile-safari
// flakes from per-IP brute-force budget exhaustion when many sign-ins
// stack up across browsers under workers=1.
test.beforeEach(async () => {
  await clearE2ERateLimits();
});

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  // F5R6+ fix — exclude /admin/sign-in (regex substring match bug).
  await page.waitForURL(/\/admin(\/(?!sign-in)|$)/, { timeout: 10_000 });
}

async function resolveAdminUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (rows.length === 0) throw new Error('e2e: no admin user seeded');
  return rows[0]!.id;
}

async function setupIssuedInvoice(
  page: import('@playwright/test').Page,
): Promise<{ tenant: ThrowawayTenant; invoiceId: string }> {
  const tenant = await createThrowawayTenant({
    seedSettings: true,
    seedMember: true,
    seedPlan: true,
  });
  const draftId = randomUUID();
  const adminUserId = await resolveAdminUserId();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(contacts).values({
      tenantId: tenant.slug,
      contactId: randomUUID(),
      memberId: tenant.memberId!,
      firstName: 'E2E',
      lastName: 'Contact',
      email: `e2e-${randomUUID().slice(0, 8)}@test.example.com`,
      isPrimary: true,
    });
    await tx.insert(invoices).values({
      tenantId: tenant.slug,
      invoiceId: draftId,
      memberId: tenant.memberId!,
      planId: 'regular',
      planYear: 2026,
      status: 'draft',
      draftByUserId: adminUserId,
      currency: 'THB',
      subtotalSatang: 1_000_000n,
      vatSatang: 70_000n,
      totalSatang: 1_070_000n,
      vatRateSnapshot: '0.0700',
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.slug,
      invoiceId: draftId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิกประจำปี 2026',
      descriptionEn: 'Annual fee 2026',
      quantity: '1',
      unitPriceSatang: 1_000_000n,
      totalSatang: 1_000_000n,
      position: 1,
    });
  });

  await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
  await signInAdmin(page);
  await page.goto('/admin/invoices');
  const issueResp = await page.context().request.post(
    `/api/invoices/${draftId}/issue`,
    {
      headers: {
        'Content-Type': 'application/json',
        Origin: new URL(page.url()).origin,
        'X-Tenant': tenant.slug,
      },
      data: {},
    },
  );
  const issueStatus = issueResp.status();
  if (!(issueStatus >= 200 && issueStatus < 300)) {
    const body = await issueResp.text();
    throw new Error(
      `setupIssuedInvoice: issue API → ${issueStatus}: ${body.slice(0, 500)}`,
    );
  }
  return { tenant, invoiceId: draftId };
}

test.describe('@us2 record-payment', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );

  test.describe('throwaway-tenant pay flows (T115t)', () => {
    test.skip(
      process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
      'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant',
    );

    test('AS1 admin records bank transfer → status=paid', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
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
              paymentDate: new Date().toISOString().slice(0, 10),
              paymentReference: 'E2E-AS1',
              paymentNotes: 'admin records bank transfer',
            },
          },
        );
        const payStatus = payResp.status();
        if (!(payStatus >= 200 && payStatus < 300)) {
          const body = await payResp.text();
          throw new Error(
            `POST /api/invoices/${invoiceId}/pay → ${payStatus}: ${body.slice(0, 500)}`,
          );
        }
        const row = await runInTenant(tenant.ctx, async (tx) =>
          tx.select().from(invoices).where(eq(invoices.invoiceId, invoiceId)),
        );
        expect(row[0]!.status).toBe('paid');
        expect(row[0]!.paidAt).not.toBeNull();
        expect(row[0]!.paymentMethod).toBe('bank_transfer');
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS2 receipt PDF downloads (shape contract)', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        // First pay so receipt PDF is generated.
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
              paymentDate: new Date().toISOString().slice(0, 10),
              paymentReference: 'E2E-AS2',
            },
          },
        );
        expect([200, 201, 204]).toContain(payResp.status());

        // Download receipt PDF.
        // The receipt PDF endpoint is /api/invoices/<id>/receipt/pdf
        // (different from invoice PDF at /api/invoices/<id>/pdf). For
        // combined-mode tenants (default), one PDF serves both roles
        // and the invoice endpoint suffices.
        const pdfResp = await page.context().request.get(
          `/api/invoices/${invoiceId}/pdf`,
          {
            headers: { 'X-Tenant': tenant.slug },
            failOnStatusCode: false,
          },
        );
        expect(pdfResp.status()).toBe(200);
        expect(pdfResp.headers()['content-type']).toContain('application/pdf');
        const pdfBuf = await pdfResp.body();
        // Shape contract — content text is FlateDecode-compressed;
        // bilingual labels verified in unit deterministic-render test.
        expect(pdfBuf.toString('latin1', 0, 4)).toBe('%PDF');
        expect(pdfBuf.length).toBeGreaterThan(1024);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS3 invoice_paid audit row emitted', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        await page.context().request.post(
          `/api/invoices/${invoiceId}/pay`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: {
              paymentMethod: 'bank_transfer',
              paymentDate: new Date().toISOString().slice(0, 10),
              paymentReference: 'E2E-AS3',
            },
          },
        );
        // Query audit_log for invoice_paid event tied to this invoice.
        const auditRows = await db
          .select({ id: auditLog.id, eventType: auditLog.eventType })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenant.slug),
              eq(auditLog.eventType, 'invoice_paid' as never),
              sql`payload->>'invoice_id' = ${invoiceId}`,
            ),
          );
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });

  test('AS4 /admin/invoices (list view) has no partial-payment affordance anywhere', async ({
    page,
  }) => {
    await signInAdmin(page);

    // Walk the invoice surfaces a manager or admin could touch during
    // the payment flow. None of them should reveal a "partial amount"
    // affordance — partial payments are OUT of MVP scope (spec §US2 AS4).
    for (const route of [
      '/admin/invoices',
      '/admin/invoices?status=issued',
    ]) {
      await page.goto(route);
      // Wait on the h1 landmark instead of `networkidle` — analytics
      // beacons keep network busy indefinitely on some deploys (L3).
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const partial = page.getByText(/partial (amount|payment)/i);
      await expect(partial).toHaveCount(0);
    }

    // Visit the list page — verify there's no "Record partial payment"
    // button or input anywhere in the rendered DOM.
    const partialInputs = page.locator('input[name*="partial"], input[id*="partial"]');
    await expect(partialInputs).toHaveCount(0);
  });
});
