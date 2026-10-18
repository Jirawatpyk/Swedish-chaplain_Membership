/**
 * @critical slim path: issue ONE invoice on the seeded `swecham` tenant
 * (spec 123 slice 2, DW-7; PR #586 review H4).
 *
 * `invoice-draft-issue.spec.ts` covers the issue flow in depth, but on a
 * throwaway tenant, which the per-PR CI run cannot use. This spec walks the
 * same seam on the shared seed instead: the e2e admin opens the seeded
 * "E2E Mutation Co" member (`E2E_ADMIN_MUTATION_MEMBER`, from
 * seed-f4-e2e-admin-fixtures), creates a draft from the member page the way
 * AS1 does, issues it through `POST /api/invoices/[id]/issue` the way AS3
 * does (the dialog is covered elsewhere and is slow on a cold route), and
 * checks the issued status and document number on the API response and on
 * the reloaded detail page.
 *
 * chromium and mobile-chrome both issue on the same CI branch, so the number
 * is matched by shape, never by value.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const MEMBER_NAME = process.env.E2E_ADMIN_MUTATION_MEMBER;

test.describe('issue one invoice on the seeded tenant @f4 @critical', () => {
  test.skip(!MEMBER_NAME, 'E2E_ADMIN_MUTATION_MEMBER is exported by scripts/seed-f4-e2e-admin-fixtures.ts');

  test('admin drafts an invoice from the member page and issues it', async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);

    // 1. The seeded member, through the directory search.
    await page.goto(`/admin/members?q=${encodeURIComponent(MEMBER_NAME!)}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
    const memberLink = page
      .getByRole('link', { name: new RegExp(MEMBER_NAME!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .first();
    await expect(memberLink).toBeVisible({ timeout: 15_000 });
    await memberLink.click();
    await page.waitForURL(/\/admin\/members\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // 2. Draft from the member page (the form pre-selects the member).
    const createInvoiceLink = page
      .getByRole('link', { name: /create (new|first) invoice|new invoice/i })
      .first();
    await expect(createInvoiceLink).toBeVisible({ timeout: 15_000 });
    await createInvoiceLink.click();
    await page.waitForURL(/\/admin\/invoices\/new(\?|$)/, { timeout: 15_000 });
    const createDraft = page.getByRole('button', { name: /create draft/i });
    await expect(createDraft).toBeEnabled({ timeout: 15_000 });
    await createDraft.click();
    // The seeded member already holds a 2026 invoice (the F4 fixtures), so the
    // form asks before a second one (run 39108085903). Confirm it.
    const draftUrl = /\/admin\/invoices\/[0-9a-f-]{36}$/;
    const second = page.getByRole('alertdialog').getByRole('button', { name: /create a second invoice/i });
    // Either the draft page or the confirm dialog, whichever comes first.
    await expect
      .poll(async () => draftUrl.test(page.url()) || (await second.isVisible()), { timeout: 20_000 })
      .toBe(true);
    if (!draftUrl.test(page.url())) {
      await second.click();
    }
    await page.waitForURL(draftUrl, { timeout: 20_000 });
    const draftId = /\/admin\/invoices\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    await expect(page.getByText(/^draft$/i).first()).toBeVisible({ timeout: 15_000 });

    // 3. Issue.
    const response = await page.context().request.post(`/api/invoices/${draftId}/issue`, {
      headers: { 'Content-Type': 'application/json', Origin: new URL(page.url()).origin },
      data: {},
    });
    const status = response.status();
    if (status < 200 || status >= 300) {
      throw new Error(`POST /api/invoices/${draftId}/issue → ${status}: ${(await response.text()).slice(0, 300)}`);
    }
    const issued = (await response.json()) as {
      status: string;
      document_number: string | null;
      bill_document_number_raw: string | null;
    };
    expect(issued.status).toBe('issued');
    // 088: the issued ใบแจ้งหนี้ carries a bill number; the §87 tax number comes at payment.
    const number = issued.bill_document_number_raw ?? issued.document_number;
    expect(number, 'the issued invoice carries a document number').toMatch(/^[A-Z]{1,8}-?\d{2,4}-?\d+/);

    // 4. The detail page shows it.
    await page.reload();
    await expect(page.getByText(number!, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^issued$/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
