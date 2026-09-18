/**
 * F119 T139 (US6-AS6, FR-051, SC-013) — the automated WCAG 2.1 AA pass on
 * every E-Blast screen **PR-1 builds**, taken at 320 CSS px, plus the two
 * keyboard/layout assertions FR-051 and FR-050 name by hand.
 *
 * The screens are named by IDENTITY, never by count (plan Amendment 4 —
 * `/speckit.analyze` M1 caught an earlier "seven / two" phrasing that
 * enumerated eight and summed to ten):
 *
 *   1. portal compose            `/portal/broadcasts/new`
 *   2. portal benefits tab       `/portal/benefits?tab=broadcasts`
 *                                (`/portal/benefits/e-blasts` is a
 *                                `permanentRedirect` onto this tab since 058 G1,
 *                                so the tab IS the screen FR-051 names)
 *   3. staff queue               `/admin/broadcasts`
 *   4. staff compose-on-behalf   `/admin/broadcasts/new`
 *   5. template surface          `/admin/broadcasts/templates`, `…/new`,
 *                                `…/[id]/edit` — one surface, three routes
 *   6. E-Blast settings          `/admin/settings/broadcasts`
 *   7. Brand settings            `/admin/settings/broadcasts/brand`
 *   8. portal E-Blast detail     `/portal/broadcasts/[id]` — the BODY view T141
 *                                builds. PR-2 rescans this screen as the
 *                                sign-off compare view (T086a); a screen takes
 *                                the pass in EVERY delivery that changes it.
 *
 * `/admin/broadcasts/[id]` is deliberately absent: T063 builds it in PR-2 and
 * T086a scans it there. Gating PR-1 on a screen PR-1 does not build would be an
 * unsatisfiable merge gate.
 *
 * **axe does not enter the body view's frame.** `PreviewSurface` puts the
 * rendered email in an `<iframe srcdoc sandbox="">`; the empty sandbox
 * allow-list withholds `allow-same-origin`, so the frame's document is a unique
 * opaque origin that `@axe-core/playwright` cannot inject its runner into. What
 * is asserted here is the HOST document plus the frame's own accessible name
 * (WCAG 4.1.2 — a frame must be titled); the email markup inside it is covered
 * by the renderer's own unit tests, not by this scan. Saying so is the point:
 * a scan that silently stops at a frame boundary would otherwise read as
 * coverage it does not have.
 *
 * Personas: staff screens sign in as `e2e-admin` (holds `broadcasts.read`,
 * `broadcasts.write` and `settings.broadcasts`). Member screens sign in as
 * **`e2e-member-empty`**, never the primary `e2e-member` — the primary carries
 * a LAPSED renewal cycle by the F8 fixture, so `/portal/broadcasts/new`
 * redirects away from the form and the scan would be taken on the wrong page.
 *
 * Run: `pnpm test:e2e tests/e2e/broadcasts/eblast-a11y.spec.ts --workers=1`,
 * in foreground chunks — `--workers=1` is mandatory on this machine.
 */
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../fixtures';
import { runAxeScan, type AxeScanOptions } from '../helpers/axe-scan';
import { signInAsAdmin } from '../helpers/admin-session';
import {
  seedMemberDetailBroadcast,
  wipeE2EMemberBroadcasts,
} from '../helpers/broadcasts-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
/** The in-good-standing persona — see the persona note in the header. */
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

const staffSkip = !ADMIN_EMAIL || !ADMIN_PASSWORD;
const memberSkip = !MEMBER_EMAIL || !MEMBER_PASSWORD;

/**
 * WCAG 2.1 1.4.10 reflow: 320 CSS px is the narrow end the standard names
 * (1280 px at 400 % zoom). Every scan below is taken there because that is the
 * width at which E-Blast layout defects actually appear — the audit that
 * produced US6 found them on phones.
 */
const REFLOW_VIEWPORT = { width: 320, height: 800 } as const;
/** `lg` in Tailwind v4 — the breakpoint T148's two-column compose layout uses. */
const LG_VIEWPORT = { width: 1280, height: 900 } as const;

/** Cold Turbopack compiles (Tiptap especially) dominate every case here. */
test.describe.configure({ timeout: 240_000, retries: 0 });

async function signInAsPortalMember(page: Page): Promise<void> {
  await page.goto('/portal/sign-in');
  const email = page.locator('input#email');
  const password = page.locator('input#password');
  await email.click();
  await email.fill(MEMBER_EMAIL!);
  await expect(email).toHaveValue(MEMBER_EMAIL!);
  await password.click();
  await password.fill(MEMBER_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
    },
    { timeout: 120_000 },
  );
}

/**
 * Navigate, prove the screen is REALLY the screen, then scan.
 *
 * The reachability proof is not optional: under `next dev` a `notFound()` still
 * answers HTTP 200, so `response.status() < 400` would pass on a 404 shell and
 * the scan would report a clean bill of health for a page that does not exist.
 * Every caller therefore passes an `anchor` locator that only the real screen
 * renders, and it is awaited BEFORE axe runs.
 */
async function scanScreen(
  page: Page,
  testInfo: TestInfo,
  url: string,
  anchor: (page: Page) => ReturnType<Page['locator']>,
  options: AxeScanOptions = {},
): Promise<void> {
  await page.setViewportSize(REFLOW_VIEWPORT);
  await page.goto(url);
  await expect(anchor(page)).toBeVisible({ timeout: 120_000 });
  await runAxeScan(page, testInfo, options);
}

/** The Tiptap editor surface — also the signal its code-split chunk landed. */
const editorAnchor = (page: Page) =>
  page.locator('[contenteditable="true"]').first();

test.describe('@a11y F119 T139 — E-Blast screens PR-1 builds (320 px)', () => {
  test.describe('member screens', () => {
    test.skip(
      memberSkip,
      'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY (scripts/seed-e2e-portal-invoices.ts)',
    );

    test('screen 1 — portal compose /portal/broadcasts/new', async ({
      page,
    }, testInfo) => {
      await signInAsPortalMember(page);
      await scanScreen(page, testInfo, '/portal/broadcasts/new', editorAnchor);
    });

    test('screen 2 — portal benefits E-Blast tab /portal/benefits?tab=broadcasts', async ({
      page,
    }, testInfo) => {
      await signInAsPortalMember(page);
      await scanScreen(page, testInfo, '/portal/benefits?tab=broadcasts', (p) =>
        // The E-Blast tab only exists for a plan that carries the benefit, and
        // `resolveBenefitsTab` falls back to the Benefits tab when it does not.
        // So the anchor is the E-Blast PANEL itself — one of its exactly two
        // render branches — not `getByRole('tab', { selected: true })`, which
        // the fallback would satisfy just as happily and hand axe the wrong
        // screen under the right test name.
        p
          .getByTestId('broadcast-history-table')
          .or(p.getByTestId('broadcast-empty-state')),
      );
    });

    test('screen 8 — portal E-Blast detail /portal/broadcasts/[id] body view', async ({
      page,
    }, testInfo) => {
      // The detail page resolves the member from the SESSION and answers 404
      // for a row another member owns, so the fixture must belong to the
      // persona that signs in. Wipe first: the seeder is keyed by subject, the
      // wipe by member, and leaving prior rows behind is what makes the
      // benefits history table non-deterministic.
      await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
      const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
      test.skip(
        broadcastId === null,
        'Set DATABASE_URL — the detail screen needs a broadcast the persona owns',
      );

      await signInAsPortalMember(page);
      // `exclude` the sandboxed frame, for the reason the header states and for
      // one more: on WebKit, axe's `runPartialRecursive` HANGS on an
      // opaque-origin frame (measured 2026-09-18 — mobile-safari blew the 240 s
      // test timeout inside `builder.analyze()`, then failed in `finishRun`'s
      // blank-page aggregation with "Target page, context or browser has been
      // closed"). Excluding the frame keeps axe on the host document, which is
      // the only document it could ever have reported on here.
      await scanScreen(
        page,
        testInfo,
        `/portal/broadcasts/${broadcastId}`,
        (p) => p.getByRole('region', { name: /content/i }),
        { exclude: 'iframe[srcdoc]' },
      );

      // WCAG 4.1.2 — the sandboxed frame carries the body, and a frame without
      // an accessible name is an unlabelled landmark to a screen reader. axe
      // cannot see INSIDE it (header note), so the frame's own name is asserted
      // here by hand rather than left to the scan.
      const frame = page.locator('iframe[srcdoc]');
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('title', /.+/);
      await expect(frame).toHaveAttribute('sandbox', '');
    });
  });

  test.describe('staff screens', () => {
    test.skip(staffSkip, 'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD');

    test('screen 3 — staff queue /admin/broadcasts', async ({
      page,
    }, testInfo) => {
      await signInAsAdmin(page);
      await scanScreen(page, testInfo, '/admin/broadcasts', (p) =>
        p.getByRole('heading', { level: 1 }),
      );
    });

    test('screen 4 — staff compose-on-behalf /admin/broadcasts/new', async ({
      page,
    }, testInfo) => {
      await signInAsAdmin(page);
      await scanScreen(page, testInfo, '/admin/broadcasts/new', editorAnchor);
    });

    test('screen 5 — template list, new and edit (one surface)', async ({
      page,
    }, testInfo) => {
      await signInAsAdmin(page);

      await scanScreen(page, testInfo, '/admin/broadcasts/templates', (p) =>
        p.getByRole('heading', { level: 1 }),
      );

      // The edit route is only scannable when a template exists. Which of the
      // two states the list is in is READ, never assumed: a bare
      // `if (editHref !== null)` cannot tell "this tenant has no templates"
      // from "my selector stopped matching", and the second one would quietly
      // drop a third of this screen from the pass.
      const listIsEmpty =
        (await page.getByTestId('broadcast-templates-empty').count()) > 0;
      const editHref = listIsEmpty
        ? null
        : await page
            .locator('a[href*="/admin/broadcasts/templates/"][href$="/edit"]')
            .first()
            .getAttribute('href');
      if (!listIsEmpty) {
        expect(
          editHref,
          'a non-empty template list must expose an edit link',
        ).not.toBeNull();
      }

      await scanScreen(page, testInfo, '/admin/broadcasts/templates/new', editorAnchor);

      if (editHref !== null) {
        await scanScreen(page, testInfo, editHref, editorAnchor);
      } else {
        testInfo.annotations.push({
          type: 'note',
          description:
            'template edit route not scanned — the list rendered its empty state',
        });
      }
    });

    test('screen 6 — E-Blast settings /admin/settings/broadcasts', async ({
      page,
    }, testInfo) => {
      await signInAsAdmin(page);
      await scanScreen(page, testInfo, '/admin/settings/broadcasts', (p) =>
        p.getByRole('heading', { level: 1 }),
      );
    });

    test('screen 7 — Brand settings /admin/settings/broadcasts/brand', async ({
      page,
    }, testInfo) => {
      await signInAsAdmin(page);
      await scanScreen(page, testInfo, '/admin/settings/broadcasts/brand', (p) =>
        p.getByRole('heading', { level: 1 }),
      );
    });
  });

  test.describe('keyboard + reflow behaviours FR-050/FR-051 name by hand', () => {
    test.skip(
      memberSkip,
      'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY (scripts/seed-e2e-portal-invoices.ts)',
    );

    test('the formatting toolbar is operable with arrow keys', async ({
      page,
      browserName,
      isMobile,
    }) => {
      // iOS-emulated WebKit has no hardware Tab/Arrow keys and does not move
      // focus the way a desktop UA does — the desktop projects carry this
      // assertion (same carve-out as nav-a11y.spec.ts's skip-link case).
      test.skip(
        browserName === 'webkit' && isMobile === true,
        'no keyboard navigation on iOS-emulated webkit',
      );

      await signInAsPortalMember(page);
      await page.setViewportSize(LG_VIEWPORT);
      await page.goto('/portal/broadcasts/new');
      await expect(editorAnchor(page)).toBeVisible({ timeout: 120_000 });

      const toolbar = page.getByRole('toolbar').first();
      await expect(toolbar).toBeVisible();
      const controls = toolbar.locator('[data-toolbar-control]');
      const count = await controls.count();
      expect(count).toBeGreaterThan(2);

      // WCAG 2.1 2.1.1 + the ARIA toolbar pattern: ONE tab stop for the whole
      // group, arrows within it. Before F119 every button was its own tab stop,
      // so a keyboard user Tabbing out of the toolbar walked ~13 controls.
      const tabStops = await controls.evaluateAll((els) =>
        els.filter((el) => el.getAttribute('tabindex') === '0').length,
      );
      expect(tabStops, 'exactly one roving tab stop').toBe(1);

      const nameOf = (i: number) => controls.nth(i).getAttribute('aria-label');
      const focusedName = () =>
        page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);

      await controls.first().focus();
      expect(await focusedName()).toBe(await nameOf(0));

      await page.keyboard.press('ArrowRight');
      expect(await focusedName(), 'ArrowRight moves to the next control').toBe(
        await nameOf(1),
      );

      await page.keyboard.press('ArrowLeft');
      expect(await focusedName(), 'ArrowLeft moves back').toBe(await nameOf(0));

      await page.keyboard.press('End');
      expect(await focusedName(), 'End jumps to the last control').toBe(
        await nameOf(count - 1),
      );

      await page.keyboard.press('Home');
      expect(await focusedName(), 'Home jumps to the first control').toBe(
        await nameOf(0),
      );

      // Still exactly one tab stop after the walk — the roving index followed
      // focus rather than leaving a second stop behind.
      const tabStopsAfter = await controls.evaluateAll((els) =>
        els.filter((el) => el.getAttribute('tabindex') === '0').length,
      );
      expect(tabStopsAfter, 'still exactly one roving tab stop').toBe(1);
    });

    test('T148 — the compose page has no horizontal scroll at 320 px and stacks below lg', async ({
      page,
    }) => {
      await signInAsPortalMember(page);

      await page.setViewportSize(REFLOW_VIEWPORT);
      await page.goto('/portal/broadcasts/new');
      await expect(editorAnchor(page)).toBeVisible({ timeout: 120_000 });

      // FR-050 / WCAG 1.4.10: the 72 rem two-column layout must not cost the
      // narrow viewport a horizontal scrollbar. `scrollWidth` is the document's
      // own content width — an overflowing child widens it.
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(scrollWidth, 'no horizontal page scroll at 320 px').toBeLessThanOrEqual(
        REFLOW_VIEWPORT.width,
      );

      const preview = page.getByRole('region', { name: /preview/i }).first();
      // `#broadcast-subject` rather than `getByLabel(/subject/i)`: the subject
      // COUNTER is labelled from the same word and the strict locator would
      // resolve to two nodes.
      const subject = page.locator('#broadcast-subject');
      await expect(preview).toBeVisible();
      await expect(subject).toBeVisible();

      const narrowSubject = await subject.boundingBox();
      const narrowPreview = await preview.boundingBox();
      expect(narrowSubject).not.toBeNull();
      expect(narrowPreview).not.toBeNull();
      // Stacked: the preview starts below the editor column, not beside it.
      expect(
        narrowPreview!.y,
        'preview sits BELOW the editor at 320 px',
      ).toBeGreaterThan(narrowSubject!.y + narrowSubject!.height);

      await page.setViewportSize(LG_VIEWPORT);
      await expect(editorAnchor(page)).toBeVisible();
      const wideSubject = await subject.boundingBox();
      const widePreview = await preview.boundingBox();
      expect(wideSubject).not.toBeNull();
      expect(widePreview).not.toBeNull();
      // Side by side: the preview column starts to the RIGHT of the editor
      // column and overlaps it vertically.
      expect(
        widePreview!.x,
        'preview sits BESIDE the editor at 1280 px',
      ).toBeGreaterThan(wideSubject!.x + wideSubject!.width);
      expect(
        widePreview!.y,
        'preview shares the editor row at 1280 px',
      ).toBeLessThan(wideSubject!.y + wideSubject!.height);
    });
  });
});
