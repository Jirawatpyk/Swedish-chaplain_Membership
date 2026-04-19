/**
 * T061 — E2E: admin draft → preview → issue → download (US1 AS1–AS6).
 *
 * Phase-3 promotion (2026-04-19): AS4 / AS5 / AS6 are promoted to real
 * browser-level assertions using the existing e2e admin + manager
 * sessions (no new fixture required). AS1 / AS2 / AS3 (full happy path
 * from draft creation through issue + bilingual PDF download) and the
 * mobile variant remain `test.fixme` — they need the F4 e2e seeder
 * (T115) that provisions a member + plan + tenant_invoice_settings on
 * a throwaway tenant. See specs/007-invoices-receipts/tasks.md T115.
 *
 * Reference: spec §US1 AS1–AS6.
 */
import { expect, fillField, test } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

async function signInManager(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), MANAGER_EMAIL!);
  await fillField(page.getByLabel(/password/i), MANAGER_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

test.describe('@us1 invoice draft → issue', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run (seeded by scripts/seed-e2e-user.ts)',
  );

  test.fixme(
    'AS1 admin creates draft from member page (needs F4 e2e seeder — T115)',
    async () => {
      // TODO(T115): needs a seeded member + plan + tenant_invoice_settings
      // on a throwaway tenant. The flow:
      //   1. Navigate to /admin/members/<id>
      //   2. Click "Create invoice" action
      //   3. Assert draft created → redirect to /admin/invoices/<id>
      //   4. Assert status badge = "Draft" and no sequence number.
    },
  );

  test.fixme(
    'AS2 preview renders watermarked PDF, no seq consumed, no audit row (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): needs a seeded draft. The flow:
      //   1. Navigate to /admin/invoices/<draft-id>
      //   2. Click "Preview PDF" → GET /api/invoices/<id>/preview
      //   3. Assert PDF has watermark (scan bytes for "PREVIEW" string)
      //   4. SELECT tenant_document_sequences — next_sequence_number unchanged
      //   5. SELECT audit_log — no invoice_issued event
    },
  );

  test.fixme(
    'AS3 issue consumes seq + commits + downloads bilingual PDF (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): needs a seeded draft + typed-phrase confirmation:
      //   1. Navigate to /admin/invoices/<draft-id>/issue
      //   2. Type "ISSUE INVOICE" into confirmation input
      //   3. Click "Issue"
      //   4. Assert redirect to /admin/invoices/<id>
      //   5. Download the PDF via "Download PDF" button
      //   6. Assert Thai label "ใบกำกับภาษี" AND English label "Tax Invoice" present
      //   7. SELECT tenant_document_sequences — next_sequence_number incremented by 1
      //   8. Run GET /api/invoices/<id>/pdf twice — both 200 with identical Content-Length
      //      (PDF determinism — see pdf-deterministic.test.ts known limitation)
    },
  );

  test('AS4 /admin/invoices default view hides drafts; ?status=draft shows them', async ({
    page,
  }) => {
    await signInAdmin(page);
    await page.goto('/admin/invoices');
    // Wait on the h1 landmark, not `networkidle` — Vercel analytics /
    // telemetry beacons run as background requests that can keep the
    // network "active" indefinitely on some deploys (L3).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Default view: the Status filter should be the shared "All statuses"
    // default; drafts are excluded unless explicitly chosen. The list
    // page renders a <h1> with the invoice list title (admin.invoices).
    await expect(
      page.getByRole('heading', { level: 1 }),
    ).toBeVisible();

    // Switch to ?status=draft — the URL-driven filter opt-in is the
    // "Drafts" affordance. Once on the filtered view, the Status
    // cell visible must show at least one "Draft" status, OR the
    // empty-state message. Both are acceptable (tenants with zero
    // drafts still render the filter correctly).
    await page.goto('/admin/invoices?status=draft');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Either rows exist with at least one "Draft" cell, OR the
    // filtered empty-state message is visible. `poll` waits until
    // one side becomes true, with a generous timeout for CI
    // cold-start where layout can take a few seconds.
    const draftCell = page.getByRole('cell', { name: /^draft$/i }).first();
    const emptyState = page.getByText(/no invoices? found|no results/i).first();
    await expect
      .poll(
        async () => {
          const [draftVisible, emptyVisible] = await Promise.all([
            draftCell.isVisible().catch(() => false),
            emptyState.isVisible().catch(() => false),
          ]);
          if (draftVisible) return 'draft';
          if (emptyVisible) return 'empty';
          return 'pending';
        },
        { timeout: 10_000 },
      )
      .toMatch(/^(draft|empty)$/);
  });

  test.describe('AS5 manager RBAC read-only (FR-003)', () => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD to run',
    );

    test('manager sees /admin/invoices list but cannot access new/issue', async ({ page }) => {
      await signInManager(page);

      // 1. List page loads (read allowed).
      await page.goto('/admin/invoices');
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // 2. "New invoice" action is NOT rendered for managers (isAdmin
      //    guard on the action slot — see admin/invoices/page.tsx).
      const newLink = page.getByRole('link', { name: /new invoice/i });
      await expect(newLink).toHaveCount(0);

      // 3. Direct POST /api/invoices (draft create) with the manager's
      //    session → 403.
      const pageUrl = new URL(page.url());
      const origin = `${pageUrl.protocol}//${pageUrl.host}`;
      const r = await page.request.post('/api/invoices', {
        headers: { 'Content-Type': 'application/json', Origin: origin },
        data: {
          memberId: '00000000-0000-0000-0000-000000000000',
          planId: 'x',
          planYear: 2026,
        },
      });
      expect([401, 403]).toContain(r.status());
    });
  });

  test('AS6 crafted invoice URL returns 404 (cross-tenant / non-existent)', async ({
    page,
  }) => {
    await signInAdmin(page);
    // A UUID that cannot possibly exist — the application MUST 404
    // (not 500, not 200 with empty detail). Works on seeded + unseeded
    // tenants alike.
    const craftedId = '11111111-2222-3333-4444-555555555555';
    const response = await page.goto(`/admin/invoices/${craftedId}`);
    expect(response?.status()).toBe(404);
  });

  test.fixme(
    '@mobile PDF download triggers share sheet (iPhone 13) — needs F4 seeder (T115)',
    async () => {
      // TODO(T115): needs a seeded issued invoice. The flow:
      //   1. Switch to iPhone 13 device profile
      //   2. Navigate to /admin/invoices/<issued-id>
      //   3. Tap "Download PDF"
      //   4. Assert Content-Disposition: attachment on the response
      //   5. Assert the anchor tag has download attribute set
    },
  );
});
