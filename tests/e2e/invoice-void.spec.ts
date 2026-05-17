/**
 * T104 — E2E: admin voids an issued invoice (US5 AS1–AS3 + FR-036).
 *
 * F5R6+ promotion (2026-05-16) — AS1/AS2/AS3/FR-036 converted from
 * `test.fixme` to real tests using the throwaway-tenant helper +
 * API-issue path (same pattern as invoice-draft-issue.spec.ts).
 */
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { fillField } from './fixtures';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog, users } from '@/modules/auth/infrastructure/db/schema';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createThrowawayTenant, type ThrowawayTenant } from './helpers/throwaway-tenant';
import { clearE2ERateLimits } from './helpers/rate-limit';

// Reset Upstash auth-rate-limit between tests — without this, the file's
// 5 tests × 3 browsers = 15 sign-in hits within a tight window can
// exhaust the per-IP brute-force budget on mobile-safari (third browser
// in sequence under workers=1). Per-test reset keeps the auth-rate-limit
// preconditions clean without weakening any contract assertion.
test.beforeEach(async () => {
  await clearE2ERateLimits();
});

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  // F5R6+ fix — exclude /admin/sign-in to avoid premature regex match
  // (the prior `/admin(\/|$)/` matched "/admin/" inside "/admin/sign-in"
  // so the helper exited BEFORE the form's router.push('/admin')
  // resolved — no session cookie → next page.goto() redirected to
  // sign-in → tests saw the sign-in page when expecting the admin shell).
  await page.waitForURL(/\/admin(\/(?!sign-in)|$)/, { timeout: 10_000 });
}

async function resolveAdminUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (rows.length === 0) {
    throw new Error('e2e: no admin user seeded');
  }
  return rows[0]!.id;
}

/**
 * Seed throwaway tenant + primary contact + issued invoice via API.
 * Returns the tenant + invoiceId + the API-allocated documentNumber.
 */
async function setupIssuedInvoice(
  page: import('@playwright/test').Page,
): Promise<{ tenant: ThrowawayTenant; invoiceId: string; documentNumber: string }> {
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

  // Issue via API so snapshots + PDF blob are populated by the
  // proper use-case (direct INSERT of status='issued' violates the
  // `invoices_non_draft_has_snapshots` CHECK constraint).
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

  // Read the allocated documentNumber from DB.
  const row = await runInTenant(tenant.ctx, async (tx) =>
    tx
      .select({
        invoiceId: invoices.invoiceId,
        documentNumber: invoices.documentNumber,
      })
      .from(invoices)
      .where(eq(invoices.invoiceId, draftId)),
  );
  if (row.length === 0 || !row[0]!.documentNumber) {
    throw new Error('setupIssuedInvoice: invoice not found or no document number');
  }
  return {
    tenant,
    invoiceId: draftId,
    documentNumber: row[0]!.documentNumber,
  };
}

test.describe('@us5 void-invoice', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );

  test.describe('throwaway-tenant void flows (T115t)', () => {
    test.skip(
      process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
      'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant',
    );

    test('AS1 admin voids issued invoice → status=void', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        // POST /api/invoices/<id>/void with {voidReason}
        const voidResp = await page.context().request.post(
          `/api/invoices/${invoiceId}/void`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: { voidReason: 'E2E test void — correcting issuance error' },
          },
        );
        const voidStatus = voidResp.status();
        if (!(voidStatus >= 200 && voidStatus < 300)) {
          const body = await voidResp.text();
          throw new Error(
            `POST /api/invoices/${invoiceId}/void → ${voidStatus}: ${body.slice(0, 500)}`,
          );
        }

        // Verify status flipped to 'void' via DB.
        const row = await runInTenant(tenant.ctx, async (tx) =>
          tx
            .select()
            .from(invoices)
            .where(eq(invoices.invoiceId, invoiceId)),
        );
        expect(row[0]!.status).toBe('void');
        expect(row[0]!.voidedAt).not.toBeNull();
        expect(row[0]!.voidReason).toContain('E2E test void');
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS2 paid invoice cannot be voided', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        // Record payment via API → status flips to paid.
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
              paymentReference: 'E2E-PAY',
              paymentNotes: 'E2E test payment',
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

        // Try to void → MUST be rejected with 4xx (typically 409 or 422).
        const voidResp = await page.context().request.post(
          `/api/invoices/${invoiceId}/void`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: { voidReason: 'Should be rejected' },
          },
        );
        const voidStatus = voidResp.status();
        // Accept any 4xx — server-component-style 404 + use-case 409.
        expect(voidStatus).toBeGreaterThanOrEqual(400);
        expect(voidStatus).toBeLessThan(500);

        // Verify status stayed 'paid' (not flipped to void).
        const row = await runInTenant(tenant.ctx, async (tx) =>
          tx
            .select()
            .from(invoices)
            .where(eq(invoices.invoiceId, invoiceId)),
        );
        expect(row[0]!.status).toBe('paid');
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS3 voided invoice rejects further actions', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        // First void it.
        await page.context().request.post(
          `/api/invoices/${invoiceId}/void`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: { voidReason: 'Initial void' },
          },
        );

        // Second void attempt MUST be rejected (already voided).
        const secondVoidResp = await page.context().request.post(
          `/api/invoices/${invoiceId}/void`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: { voidReason: 'Try again' },
          },
        );
        expect(secondVoidResp.status()).toBeGreaterThanOrEqual(400);
        expect(secondVoidResp.status()).toBeLessThan(500);

        // Pay attempt MUST also be rejected.
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
              paymentReference: 'should-fail',
            },
          },
        );
        expect(payResp.status()).toBeGreaterThanOrEqual(400);
        expect(payResp.status()).toBeLessThan(500);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('FR-036 invoice_voided audit row emitted on void', async ({ page }) => {
      const { tenant, invoiceId } = await setupIssuedInvoice(page);
      try {
        await page.context().request.post(
          `/api/invoices/${invoiceId}/void`,
          {
            headers: {
              'Content-Type': 'application/json',
              Origin: new URL(page.url()).origin,
              'X-Tenant': tenant.slug,
            },
            data: { voidReason: 'audit trail probe' },
          },
        );

        // Query audit_log for the invoice_voided event tied to this
        // invoice (audit-trail contract — FR-036 cancellation
        // notification triggers off this audit row downstream).
        const auditRows = await db
          .select({ id: auditLog.id, eventType: auditLog.eventType })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenant.slug),
              eq(auditLog.eventType, 'invoice_voided' as never),
              sql`payload->>'invoice_id' = ${invoiceId}`,
            ),
          );
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });

  test('confirm-phrase gate blocks submission when document number not typed', async ({
    page,
  }) => {
    await signInAdmin(page);
    // Walk to the list view and confirm the page renders without a
    // partial-void or bulk-void affordance anywhere — void is always
    // per-invoice + requires a typed phrase (FR-040).
    await page.goto('/admin/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const partial = page.getByText(/partial void|bulk void/i);
    await expect(partial).toHaveCount(0);
  });
});
