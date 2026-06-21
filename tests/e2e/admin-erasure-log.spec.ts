/**
 * COMP-1 US3-D (Task 5) — `@a11y @i18n` E2E for the DPO erasure-evidence log
 * (`/admin/compliance/erasure-log`).
 *
 * The read-only admin page that gives the Data Protection Officer a single,
 * accountable view of every member erasure + its full Art.17 evidence. This
 * spec closes the E2E gap left by the Task 1–4 unit/integration layers:
 *
 *   1. ADMIN happy path — a seeded erased member's evidence card renders
 *      (Member #, erased-at, a status badge, the five section headings, the
 *      re-drive note + the tax-redaction badge). M-2: the credential proof
 *      MUST NOT leak a raw actor uuid into the DOM.
 *   2. RBAC denial (CWE-285 carry-forward) — a MANAGER navigating to the page
 *      gets `notFound()` (NOT the page content) and the Erasure Log link is
 *      absent from the manager admin sidebar; a MEMBER is denied too.
 *   3. `@a11y` — axe-core WCAG 2.1 + 2.2 AA scan, no violations.
 *   4. `@i18n` — EN/TH/SV render the localised title + key labels with no
 *      `MISSING_MESSAGE` / raw-key leak.
 *
 * RBAC note: the page does `requireSession('staff')` THEN
 * `if (user.role !== 'admin') notFound()`. The F9 audit viewer admits manager;
 * THIS page deliberately does NOT — a bare staff-gate would leak erasure
 * evidence (PII + identity-verification attestations) to managers. So the
 * manager assertion is `notFound`, not the F9 "manager can also read" path.
 *
 * Tenant binding: a normal admin sign-in resolves the tenant to
 * `env.tenant.slug` (= `swecham`), so the evidence is seeded into the real
 * `swecham` tenant (see `helpers/erasure-evidence-seed.ts`). The dummy member
 * row is torn down in `afterAll` (a stray high `member_number` would break the
 * `migration-0209-post-apply` contiguity invariant on the shared dev Neon);
 * the append-only audit rows are left as-is (harmless orphans keyed on the
 * dummy's random uuid).
 *
 * Run: `pnpm test:e2e --grep "admin-erasure-log" --workers=1`
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';
import {
  seedErasureEvidenceMember,
  type ErasureEvidenceSeed,
} from './helpers/erasure-evidence-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const DATABASE_URL = process.env.DATABASE_URL;

const ROUTE = '/admin/compliance/erasure-log';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];

/** The localised page <h1> / <title> per locale (from i18n admin.compliance.erasureLog.title). */
const TITLE_RE: Record<Locale, RegExp> = {
  en: /erasure evidence log/i,
  th: /บันทึกหลักฐานการลบข้อมูล/,
  sv: /bevislogg för radering/i,
};

/** The localised nav-sidebar link label per locale (from i18n nav.staff.erasureLog). */
const NAV_LINK_RE: Record<Locale, RegExp> = {
  en: /erasure log/i,
  th: /บันทึกการลบข้อมูล/,
  sv: /raderingslogg/i,
};

/** A localised PAGE label per locale (the "Request & attestation" section h3) —
 *  rendered in the page content, so viewport-independent (unlike the sidebar
 *  link, which collapses into a closed Sheet on mobile). */
const REQUESTED_SECTION_RE: Record<Locale, RegExp> = {
  en: /Request & attestation/i,
  th: /คำขอและการยืนยันตัวตน/,
  sv: /Begäran och verifiering/i,
};

/** The localised "Complete" status badge per locale. */
const COMPLETE_STATUS_RE: Record<Locale, RegExp> = {
  en: /^Complete$/,
  th: /^เสร็จสมบูรณ์$/,
  sv: /^Slutförd$/,
};

async function setLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
  ]);
}

/**
 * Assert the current (non-admin) session is denied the erasure log:
 *   1. the underlying HTTP response carries the framework not-found markers
 *      (dev RSC streaming commits a 200 while rendering the not-found UI, prod
 *      strict-404s — accept either status, never 5xx); AND
 *   2. the rendered DOM shows NO evidence content (no page h1, no `Member #`
 *      card heading, no section headings) — the not-found UI rendered instead.
 *
 * The document `<title>` legitimately carries the localised metadata title
 * even on a not-found (Next.js resolves `generateMetadata` independently of the
 * RBAC gate in the component body), so we must NOT string-match the title out
 * of raw HTML — we assert the page CONTENT is absent via real DOM locators.
 */
async function assertErasureLogNotFound(page: Page): Promise<void> {
  const apiResponse = await page.context().request.get(ROUTE, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const status = apiResponse.status();
  const body = await apiResponse.text();
  expect(status).toBeLessThan(500);
  expect([200, 404]).toContain(status);
  expect(body).toMatch(
    /<meta\s+name="next-error"\s+content="not-found"|NEXT_HTTP_ERROR_FALLBACK;404/,
  );

  // Real-browser render: the evidence page CONTENT must be absent (the
  // built-in Next.js 404 renders instead). Assert only erasure-log-SPECIFIC
  // content is missing — the default 404 page has its own h2, so we must not
  // assert on generic heading levels.
  await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: TITLE_RE.en, level: 1 }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: /Member #\d/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: /Request & attestation/i }),
  ).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.describe('COMP-1 US3-D — erasure-evidence log (admin DPO) @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !MANAGER_EMAIL || !MEMBER_EMAIL || !DATABASE_URL,
    'Set E2E_{ADMIN,MANAGER,MEMBER}_* + DATABASE_URL in .env.local (seeded by scripts/seed-e2e-user.ts).',
  );

  let seed: ErasureEvidenceSeed;

  test.beforeAll(async () => {
    seed = await seedErasureEvidenceMember();
  });

  test.afterAll(async () => {
    await seed?.cleanup().catch(() => {});
  });

  // --- 1. ADMIN happy path --------------------------------------------------

  test('admin sees the seeded erased member evidence card (M-2: no actor uuid leak)', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });

    // Title (h1) renders localised, not a raw key.
    await expect(
      page.getByRole('heading', { name: TITLE_RE.en, level: 1 }),
    ).toBeVisible();

    // The seeded member's card heading: `Member #<memberNumber>`. Scope all
    // further assertions to THIS card (the real tenant may hold other erased
    // members).
    const cardHeading = page.getByRole('heading', {
      name: new RegExp(`Member #${seed.memberNumber}\\b`),
      level: 2,
    });
    await expect(cardHeading).toBeVisible();

    // The card is the `<li>` wrapping our heading's section.
    const card = page.locator('li', { has: cardHeading });

    // Erased-at line + a status badge (complete — the completion row is seeded).
    await expect(card.getByText(/Erased/)).toBeVisible();
    await expect(card.getByText(/^Complete$/)).toBeVisible();

    // The five evidence section headings (h3) all present.
    for (const section of [
      /Request & attestation/i,
      /Completion/i,
      /Login credential/i,
      /Tax-document redactions/i,
      /Sub-processor \(Resend\)/i,
    ]) {
      await expect(
        card.getByRole('heading', { name: section, level: 3 }),
      ).toBeVisible();
    }

    // Re-drive note (the completion row carries `re_drive: true`).
    await expect(card.getByText(/reconciler re-drive/i)).toBeVisible();

    // Tax-document redaction badge (document_kind: invoice).
    await expect(card.getByText(/^Invoice$/)).toBeVisible();

    // The Art.12 attestation surfaced (identity verified = Yes).
    await expect(card.getByText(/Identity verified/i)).toBeVisible();

    // M-2: NO raw actor uuid leaks. The seed's audit actor is the SYSTEM
    // marker `system:e2e-erasure-evidence`; the page must never render it nor
    // any bare uuid in the credential section. Assert the card's text holds
    // neither the system actor marker NOR a v4-uuid pattern.
    const cardText = (await card.innerText()).toLowerCase();
    expect(cardText).not.toContain('system:e2e-erasure-evidence');
    expect(cardText).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    // Credential section renders its "none" empty state (no linked login
    // seeded → FIX-1 drops the user_erased arm), proving no credential uuid.
    await expect(
      card.getByText(/No linked login credential was erased/i),
    ).toBeVisible();
  });

  // --- 2. RBAC denial -------------------------------------------------------

  test('manager is denied (notFound) and has no Erasure Log sidebar link', async ({
    page,
  }) => {
    await signInAsManager(page);
    await assertErasureLogNotFound(page);

    // The manager sidebar must not surface the admin-only Erasure Log link
    // (the nav roles filter hides it; it would otherwise 404). Load an admin
    // surface the manager CAN read, then assert the link is absent.
    await page.goto('/admin/renewals', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('link', { name: NAV_LINK_RE.en }),
    ).toHaveCount(0);
  });

  test('member is denied (redirected off /admin) the erasure log', async ({
    page,
  }) => {
    await signInAsMember(page);
    // A MEMBER is denied EARLIER than a manager: the `(staff)/admin/layout`
    // RBAC guard redirects `role === 'member'` to `/portal` (HTTP 307) BEFORE
    // the page's own `notFound()` runs. So the member's denial is a redirect,
    // not a not-found. Read the raw response with redirects OFF to see the 307.
    const apiResponse = await page.context().request.get(ROUTE, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const status = apiResponse.status();
    expect(status).toBeLessThan(500);
    // 3xx redirect (off /admin) — the member never reaches the page. This is
    // the deterministic security proof: a member's request is bounced to
    // /portal by the (staff) layout guard before the page (or its content)
    // ever renders. A real-browser belt-and-suspenders nav is intentionally
    // omitted — a `page.goto` to a URL that immediately 307-redirects throws
    // `ERR_ABORTED` under dev RSC streaming (the API-level check above already
    // proves the contract without that flake).
    expect(status).toBeGreaterThanOrEqual(300);
    expect(status).toBeLessThan(400);
    const location = apiResponse.headers()['location'] ?? '';
    expect(location).toContain('/portal');
  });

  // --- 3. @a11y -------------------------------------------------------------

  test('axe-core WCAG 2.1 + 2.2 AA scan — no violations', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
    // Wait for the seeded card to be on the page before scanning so axe runs
    // against the populated state (not a loading skeleton).
    await expect(
      page.getByRole('heading', {
        name: new RegExp(`Member #${seed.memberNumber}\\b`),
        level: 2,
      }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // --- 4. @i18n -------------------------------------------------------------

  for (const locale of LOCALES) {
    test(`renders in ${locale.toUpperCase()} — localised title, nav, no key leaks`, async ({
      page,
      context,
    }) => {
      await signInAsAdmin(page);
      await setLocale(context, locale);
      await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });

      // Localised <title> + <h1> — not a raw key.
      const docTitle = await page.title();
      expect(docTitle).not.toMatch(/admin\.compliance\.erasureLog/);
      expect(docTitle).toMatch(TITLE_RE[locale]);
      await expect(
        page.getByRole('heading', { name: TITLE_RE[locale], level: 1 }),
      ).toBeVisible();

      // A couple of localised PAGE labels (scoped to the seeded card so the
      // assertion is deterministic): the "Request & attestation" section h3 +
      // the "Complete" status badge. Page-content labels render the same
      // across viewports (the sidebar nav link collapses into a closed Sheet
      // on mobile, so it is NOT asserted here — its EN label is covered by the
      // manager-denial test instead).
      //
      // The card heading itself is LOCALISED (`Member #<n>` / `สมาชิกเลขที่
      // <n>` / `Medlem nr <n>`), so locate it by the member NUMBER alone — the
      // numeral is the one stable token across all three locales.
      const cardHeading = page.getByRole('heading', {
        name: new RegExp(`${seed.memberNumber}\\b`),
        level: 2,
      });
      await expect(cardHeading).toBeVisible();
      const card = page.locator('li', { has: cardHeading });
      await expect(
        card.getByRole('heading', { name: REQUESTED_SECTION_RE[locale], level: 3 }),
      ).toBeVisible();
      // Target the status BADGE specifically (`data-slot="badge"`). In Swedish
      // the status word "Slutförd" (Complete) is byte-identical to the
      // "Completed" date-field label (`fields.completedAt`), so a bare
      // `getByText` would strict-mode-violate on two elements — scope to the
      // badge slot, which the field-label <dt> is not.
      await expect(
        card.locator('[data-slot="badge"]').filter({ hasText: COMPLETE_STATUS_RE[locale] }),
      ).toBeVisible();

      // No raw i18n-key leaks for the page namespace, nav, or audit labels.
      const bodyText: string = await page.evaluate(
        () => document.body.innerText,
      );
      expect(bodyText).not.toMatch(/admin\.compliance\.erasureLog\.[a-z]/);
      expect(bodyText).not.toMatch(/nav\.staff\.[a-z]/);
      // next-intl's runtime "missing message" sentinel must never appear.
      expect(bodyText).not.toMatch(/MISSING_MESSAGE|MISSING_KEY/);
    });
  }
});
