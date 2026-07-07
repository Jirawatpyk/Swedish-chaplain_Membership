/**
 * F6 remediation PR 2.2 / P4 — `@a11y @i18n` E2E for the by-email attendee
 * erasure surface (`/admin/events/erasure`, FR-032a, GDPR Art.17 / PDPA §30).
 *
 * The admin-only destructive surface that finds every event registration
 * sharing a data subject's email and erases them in one sweep. Covers what the
 * contract test (route-level RBAC + tally) cannot:
 *
 *   1. `@a11y` — axe-core WCAG 2.1 + 2.2 AA scan of the (empty) erasure page.
 *   2. `@i18n` — EN/TH/SV render the localised title + search label with no
 *      `MISSING_MESSAGE` / raw-key leak, and the document `<title>` is name/
 *      email-free (carry-forward: no PII in the title).
 *   3. RBAC (FR-035, carry-forward #1) — a MANAGER is redirected off the page
 *      (to /admin/events); a MEMBER is bounced to /portal by the (staff) layout.
 *   4. Happy path — search an email that has N seeded registrations → see the
 *      rows → "Erase all" → success toast → re-search shows 0. DESTRUCTIVE
 *      (hard-deletes the seeded row); the seed helper re-seeds on the next run.
 *
 * RBAC note: the erasure page does `requireSession('staff')` THEN
 * `if (user.role !== 'admin') redirect('/admin/events')` — mirroring the
 * per-registration erase page. A bare staff-gate would leak the attendee
 * name+email PII preview to managers.
 *
 * Gated on E2E_{ADMIN,MANAGER,MEMBER}_* (+ DATABASE_URL for the happy-path
 * seed). Run:
 *   pnpm test:e2e --grep "admin-events-erasure" --workers=1
 * (--workers=1 is mandatory per CLAUDE.md memory feedback_e2e_workers.)
 *
 * NOTE (PR 2.2): authored in a git worktree with no dev server, so this spec
 * was NOT executed locally — it must run in CI (or against a worktree dev
 * server on :3101 via the E2E override config). It is written to the shipped
 * F6 e2e conventions (fixtures, signIn helpers, seedF6RelinkFixture, AxeBuilder,
 * NEXT_LOCALE cookie) and is not asserted as passing.
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';
import {
  seedF6RelinkFixture,
  type SeedRelinkFixtureResult,
} from './helpers/eventcreate-seed';
import en from '../../src/i18n/messages/en.json';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

const ROUTE = '/admin/events/erasure';

/**
 * The non-member attendee email seeded by `seedF6RelinkFixture` (a single
 * registration). Coupled to the literal in
 * `tests/e2e/helpers/eventcreate-seed.ts` — keep in sync if that seed changes.
 */
const SEEDED_EMAIL = 'relink-target@e2e-f6-relink.example';

const AXE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
] as const;

const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];

const erasure = en.admin.events.erasure;

/** Localised page <h1> / <title> per locale. */
const TITLE_RE: Record<Locale, RegExp> = {
  en: /erase attendee data by email/i,
  th: /ลบข้อมูลผู้เข้าร่วมตามอีเมล/,
  sv: /radera deltagardata via e-post/i,
};

/** Localised search-input label per locale. */
const SEARCH_LABEL_RE: Record<Locale, RegExp> = {
  en: /data subject email/i,
  th: /อีเมลของเจ้าของข้อมูล/,
  sv: /den registrerades e-postadress/i,
};

async function setLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
  ]);
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('PR 2.2 — by-email attendee erasure surface @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run the erasure surface e2e',
  );

  // --- 1. @a11y -------------------------------------------------------------

  test('axe-core WCAG 2.1 + 2.2 AA scan — empty erasure page, no violations', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });

    await expect(
      page.getByRole('heading', { name: TITLE_RE.en, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByLabel(SEARCH_LABEL_RE.en),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // --- 2. @i18n -------------------------------------------------------------

  for (const locale of LOCALES) {
    test(`renders in ${locale.toUpperCase()} — localised title + search label, no key leaks, name-free title`, async ({
      page,
      context,
    }) => {
      await signInAsAdmin(page);
      await setLocale(context, locale);
      await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });

      // Localised <title> + <h1> — not a raw key, and never an attendee email.
      const docTitle = await page.title();
      expect(docTitle).not.toMatch(/admin\.events\.erasure/);
      expect(docTitle).toMatch(TITLE_RE[locale]);
      // Carry-forward — the <title> must be name/email-free even after a search.
      expect(docTitle).not.toContain('@');
      await expect(
        page.getByRole('heading', { name: TITLE_RE[locale], level: 1 }),
      ).toBeVisible();
      await expect(page.getByLabel(SEARCH_LABEL_RE[locale])).toBeVisible();

      const bodyText = await page.evaluate(() => document.body.innerText);
      expect(bodyText).not.toMatch(/admin\.events\.erasure\.[a-z]/);
      expect(bodyText).not.toMatch(/MISSING_MESSAGE|MISSING_KEY/);
    });
  }

  // --- 3. RBAC (FR-035, carry-forward #1) -----------------------------------

  test('manager is redirected off the erasure page (to /admin/events)', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD',
    );
    await signInAsManager(page);
    const res = await page.context().request.get(ROUTE, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(res.status()).toBeLessThan(500);
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()['location'] ?? '').toContain('/admin/events');
  });

  test('member is bounced to /portal by the (staff) layout guard', async ({
    page,
  }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD',
    );
    await signInAsMember(page);
    const res = await page.context().request.get(ROUTE, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(res.status()).toBeLessThan(500);
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()['location'] ?? '').toContain('/portal');
  });

  // --- 4. Happy path (DESTRUCTIVE — re-seeds each run) -----------------------

  test('admin: search a seeded email → erase all → re-search shows 0', async ({
    page,
  }) => {
    test.skip(
      !DATABASE_URL,
      'Set DATABASE_URL to run the destructive happy-path erase (seeded fixture)',
    );
    const fixture: SeedRelinkFixtureResult | null = await seedF6RelinkFixture();
    if (!fixture) {
      test.skip(true, 'seedF6RelinkFixture returned null');
      return;
    }

    await signInAsAdmin(page);
    await page.goto(`${ROUTE}?email=${encodeURIComponent(SEEDED_EMAIL)}`, {
      waitUntil: 'domcontentloaded',
    });

    // The seeded non-member row surfaces its event as a row action.
    const eraseRow = page.getByTestId(
      `erase-pii-button-${fixture.nonMemberRegistrationId}`,
    );
    await expect(eraseRow).toBeVisible();

    // axe scan #1 — the POPULATED results table (the highest-risk element the
    // empty-page scan above cannot reach): headers, badges, per-row actions.
    const tableScan = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(tableScan.violations).toEqual([]);

    // Open the bulk "Erase all N" dialog.
    const eraseAll = page.getByTestId('erase-all-by-email-button');
    await expect(eraseAll).toBeVisible();
    await eraseAll.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // axe scan #2 — the OPEN AlertDialog (focus trap, labelling, reason
    // textarea + destructive action button).
    const dialogScan = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(dialogScan.violations).toEqual([]);

    // Confirm is gated on a reason (FR-032a mandatory-reason gate).
    const confirm = dialog.getByRole('button', {
      name: erasure.confirm,
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await dialog
      .getByLabel(new RegExp(erasure.reasonLabel, 'i'))
      .fill('E2E — by-email DSAR erasure request');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Success toast surfaces the tally.
    await expect(
      page.getByText(new RegExp(erasure.successTitle, 'i')),
    ).toBeVisible();

    // Re-search: the row is gone (enumeration keys the live table).
    await page.goto(`${ROUTE}?email=${encodeURIComponent(SEEDED_EMAIL)}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(
      page.getByText(new RegExp(erasure.noMatches, 'i')),
    ).toBeVisible();
    await expect(
      page.getByTestId(`erase-pii-button-${fixture.nonMemberRegistrationId}`),
    ).toHaveCount(0);
  });
});
