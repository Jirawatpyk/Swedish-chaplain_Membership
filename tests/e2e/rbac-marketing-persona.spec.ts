/**
 * T055 (016 PR 4, US3) — the marketing persona is USABLE, not merely permitted.
 *
 * The US3 independent test. `marketing` exists so communications work can be
 * done without granting the money, audit, user-administration and erasure
 * surfaces that `admin` carries. That claim has two halves, and a role that
 * satisfies only the second is useless:
 *
 *  - the E-Blast and event surfaces WORK end to end for it;
 *  - every money / PII-sensitive / compliance surface is closed.
 *
 * The "usable" half is the one that keeps getting missed. Before T064 a
 * marketing operator's ⌘K returned nothing at all — the palette's role filter
 * had a final arm that emptied every group for anyone who was neither
 * administrator nor manager — and the server was serving the entries correctly
 * the whole time.
 *
 * Preconditions: FEATURE_RBAC_V2=true + Migration C applied on the dev branch +
 * `scripts/seed-e2e-user.ts` re-run (mints e2e-marketing@swecham.test), then
 * `E2E_RBAC_V2_ON=true`. On the OFF leg D16 maps marketing to no legacy role,
 * so every staff surface denies and the whole walk would be vacuous — hence the
 * `E2E_RBAC_V2_ON` gate rather than a credentials-only one. Run:
 *   `pnpm test:e2e --grep "rbac-marketing-persona" --workers=1`
 */
import AxeBuilder from '@axe-core/playwright';
import en from '@/i18n/messages/en.json';
import { expect, test } from './fixtures';
import { signInAsMarketing } from './helpers/marketing-session';

const MARKETING_EMAIL = process.env.E2E_MARKETING_EMAIL;
const RBAC_V2_ON = process.env.E2E_RBAC_V2_ON === 'true';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Money + PII-sensitive + compliance surfaces marketing must never reach. */
const DENIED_ROUTES = [
  '/admin/invoices',
  '/admin/credit-notes',
  '/admin/renewals',
  '/admin/plans',
  '/admin/directory',
  '/admin/users',
  '/admin/audit',
  '/admin/compliance/erasure-log',
  '/admin/settings/invoicing',
  '/admin/settings/renewals/schedules',
  '/admin/settings/broadcasts',
  '/admin/settings/integrations/eventcreate',
] as const;

test.describe('T055 RBAC v2 — marketing persona (ON leg) @a11y', () => {
  test.skip(
    !MARKETING_EMAIL || !RBAC_V2_ON,
    'ON-leg suite: needs FEATURE_RBAC_V2=true + Migration C on dev + E2E_MARKETING_* ' +
      '(re-run scripts/seed-e2e-user.ts), then set E2E_RBAC_V2_ON=true. On the OFF leg ' +
      'D16 denies marketing every staff surface and this walk proves nothing.',
  );

  // The sign-in helper budgets 60s for `waitForURL` (bumped in R9.B1 to absorb
  // a Turbopack cold compile of `/admin`). Playwright's 30s TEST timeout caps
  // the whole `beforeEach`, so that 60s was unreachable and the suite only ever
  // passed against an already-warm server. `global-setup.ts` now warms the
  // routes, and this makes the helper's stated budget actually reachable if a
  // compile still lands here.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await signInAsMarketing(page);
  });

  test.describe('can do its job', () => {
    test('reaches the broadcasts list and gets the WRITE affordance', async ({ page }) => {
      await page.goto('/admin/broadcasts', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // `broadcasts.write` is in the bundle, so the compose affordance must be
      // present — a read-only broadcasts page would make the role pointless.
      // The label comes from en.json rather than a hand-written regex: my first
      // draft guessed /new broadcast/ and failed against the real
      // "Submit on behalf of member", and a guessed regex that happened to
      // match nothing would have looked like a permission bug.
      await expect(
        page.getByRole('link', { name: en.admin.broadcasts.proxySubmitButton }),
      ).toBeVisible();
    });

    test('reaches the events list and gets the CSV-import affordance', async ({ page }) => {
      // F6 has no "create event" — events originate in EventCreate or a CSV
      // import, and `events.write` gates the import CTA. That IS the write path
      // T055 names ("event registrations + CSV import").
      await page.goto('/admin/events', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(
        page.getByRole('link', { name: en.admin.events.list.importCsvCta }),
      ).toBeVisible();
    });

    test('reaches the members directory (read scope)', async ({ page }) => {
      await page.goto('/admin/members', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });

    test('the command palette returns results — not the empty shell', async ({ page, browserName, isMobile }) => {
      test.skip(browserName === 'webkit' && isMobile === true, 'palette is keyboard-only (window keydown, no touch trigger); iOS-emulated webkit does not deliver the synthetic accelerator - mobile-chrome covers the mobile arm');
      // The T064 regression: the client-side role mirror emptied every group
      // for marketing while the server was serving them correctly. An assertion
      // that the palette merely OPENS would have passed throughout.
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      await page.keyboard.press(`${MOD}+k`);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('combobox').or(dialog.locator('input')).first().fill('members');
      // At least one actionable row. `option` is what cmdk renders per item.
      await expect(dialog.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('cannot reach what it must not', () => {
    for (const route of DENIED_ROUTES) {
      test(`denied ${route}`, async ({ page }) => {
        const res = await page.context().request.get(route, {
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        const status = res.status();
        // Denial is `notFound()` (404) — marketing IS staff, so the (staff)
        // layout admits them and the PAGE gate answers. Never a 5xx, never a
        // rendered page.
        expect(status, `${route} returned ${status}`).toBeLessThan(500);
        if (status === 200) {
          expect(await res.text(), `${route} rendered for marketing`).toContain(
            'NEXT_HTTP_ERROR_FALLBACK;404',
          );
        } else {
          expect(status).toBe(404);
        }
      });
    }
  });

  test.describe('sees no data its bundle excludes', () => {
    test('the dashboard shows engagement widgets and NO finance figures', async ({ page }) => {
      await page.goto('/admin', { waitUntil: 'domcontentloaded' });
      const body = page.locator('body');

      // Anchor on a string only the DASHBOARD renders. `/member/i` was
      // satisfied by the sidebar's Members link, which is on every staff page —
      // so the page's own `forbidden` / error branch (PageHeader + sidebar, no
      // "revenue") passed every assertion in this test.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(body).toContainText(en.admin.dashboard.kpi.total);
      await expect(body).toContainText(en.admin.dashboard.kpi.atRisk);

      // Finance half is absent. Asserted on the RENDERED TEXT rather than by
      // counting cards: the widgets could be reordered without weakening this.
      await expect(body).not.toContainText(/revenue/i);
      await expect(body).not.toContainText(/overdue/i);
      // …and no artefact of a widget that read a field that is no longer there.
      await expect(body).not.toContainText('NaN');
      await expect(body).not.toContainText('undefined');
    });

    // DoB is NOT asserted here. The "Date of birth" label renders only on the
    // member EDIT form, which marketing cannot reach at all, so a
    // `not.toContainText(/date of birth/i)` on the detail page passes for every
    // role including super_admin — it proved nothing about
    // `members.pii_sensitive`. The real egress is
    // `GET /api/members/[memberId]?include=date_of_birth`, owned by
    // `tests/contract/members/get-member.test.ts`, which drives the field gate
    // directly and covers marketing on both legs. Deleting a vacuous assertion
    // is better than leaving one that looks like coverage.
  });

  test('axe-core WCAG 2.1/2.2 AA — the marketing dashboard has no violations', async ({
    page,
  }) => {
    // The engagement-only dashboard is a layout this feature INTRODUCED (three
    // KPI tiles instead of four, one full-width chart instead of two), so it
    // has never been scanned before. Its siblings are covered by
    // tests/e2e/f9-dashboard.spec.ts.
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(results.violations).toEqual([]);
  });
});
