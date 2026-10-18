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

/**
 * How long a staff page may take to render after a navigation. The CI runner
 * is in the US and the database in Singapore, so every server query crosses
 * regions: in run 39124301861 a passing attempt took ~12 s to render the
 * member page, against the 15 s waits this spec first had. The spec runs under
 * test.slow(), so this fits its budget. (The stuck-page flake was something
 * else; see the member-page step below.)
 */
const SERVER_RENDER_MS = 60_000;

test.describe('issue one invoice on the seeded tenant @f4 @critical', () => {
  test.skip(!MEMBER_NAME, 'E2E_ADMIN_MUTATION_MEMBER is exported by scripts/seed-f4-e2e-admin-fixtures.ts');

  test('admin drafts an invoice from the member page and issues it', async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);

    // 1. The seeded member, through the directory search.
    await page.goto(`/admin/members?q=${encodeURIComponent(MEMBER_NAME!)}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: SERVER_RENDER_MS });
    // Visible only, and strict (no `.first()`): Next keeps a previous segment's
    // DOM hidden after a client navigation.
    const memberLink = page
      .getByRole('link', { name: new RegExp(MEMBER_NAME!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .filter({ visible: true });
    await expect(memberLink).toBeVisible({ timeout: SERVER_RENDER_MS });
    // Open the member page by URL, not by clicking the row. In run 39136426864
    // the click's client navigation fetch (?_rsc, no prefetch header) was
    // aborted ~50 ms after the click and nothing re-fetched it, so the page sat
    // on the member route's loading.tsx for the full 60 s. That is an app-side
    // navigation issue (open, plan.md § Evidence); this spec's subject is
    // issuing an invoice, and members-directory-search covers the list.
    const memberHref = await memberLink.getAttribute('href');
    expect(memberHref, 'the directory row links to the member page').toMatch(/^\/admin\/members\/[0-9a-f-]{36}$/);
    await page.goto(memberHref!);

    // 2. Draft from the member page (the form pre-selects the member).
    // The page shows exactly one of "New invoice" / "Create first invoice".
    const createInvoiceLink = page
      .getByRole('link', { name: /create (new|first) invoice|new invoice/i })
      .filter({ visible: true });
    await expect(createInvoiceLink).toBeVisible({ timeout: SERVER_RENDER_MS });
    await createInvoiceLink.click();
    await page.waitForURL(/\/admin\/invoices\/new(\?|$)/, { timeout: 15_000 });
    const createDraft = page.getByRole('button', { name: /create draft/i });
    await expect(createDraft).toBeEnabled({ timeout: SERVER_RENDER_MS });
    await createDraft.click();
    // The seeded member already holds a 2026 invoice (the F4 fixtures), so the
    // form asks before a second one (run 39108085903). Confirm it.
    const draftUrl = /\/admin\/invoices\/[0-9a-f-]{36}$/;
    const second = page
      .getByRole('alertdialog')
      .getByRole('button', { name: /create a second invoice/i })
      .filter({ visible: true });
    // Either the draft page or the confirm dialog, whichever comes first.
    await expect
      .poll(async () => draftUrl.test(page.url()) || (await second.isVisible()), { timeout: SERVER_RENDER_MS })
      .toBe(true);
    if (!draftUrl.test(page.url())) {
      await second.click();
    }
    await page.waitForURL(draftUrl, { timeout: SERVER_RENDER_MS });
    const draftId = /\/admin\/invoices\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    // The status badge is an icon + text, so assert on the page heading, which
    // holds the loading.tsx shimmer until the page streams in.
    await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true })).toHaveText(/draft invoice/i, {
      timeout: SERVER_RENDER_MS,
    });

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
    // The page heading, not `.first()` text: on a phone the first match is the
    // hidden breadcrumb (run 39110905078).
    const heading = page.getByRole('heading', { level: 1 }).filter({ visible: true });
    await expect(heading).toContainText(number!, { timeout: SERVER_RENDER_MS });
    await expect(heading).not.toContainText(/draft/i);
  });
});
