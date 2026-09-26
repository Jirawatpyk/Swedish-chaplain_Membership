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
 * `/admin/broadcasts/[id]` is absent from the PR-1 list: T063 builds it in PR-2,
 * so it is scanned by the **T086a** block at the end of this file, together
 * with the sign-off view of `/portal/broadcasts/[id]` (T086). Both are scanned
 * in a REAL approval stage the state machine produced (driven through the UI by
 * `helpers/eblast-approval-flow.ts`), not in the pre-approval shape. The third
 * PR-2 screen, the rebuilt staff queue, is screen 3 below plus the U2, B1 and
 * H4 cases — re-run, not duplicated.
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
import {
  formatAndSendAsMarketing,
  startFormattedVersionAsMarketing,
} from '../helpers/eblast-approval-flow';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
/** The in-good-standing persona — see the persona note in the header. */
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

const staffSkip = !ADMIN_EMAIL || !ADMIN_PASSWORD;
const memberSkip = !MEMBER_EMAIL || !MEMBER_PASSWORD;

/**
 * The last test's E-Blast (with its versions, decisions and outbox rows)
 * would otherwise sit on the shared dev branch until the next run — each
 * test wipes only at its start. It also holds an allowance place for the
 * persona. T166 senior-tester M5.
 */
test.afterAll(async () => {
  if (MEMBER_EMAIL) await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
});

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
        //
        // U37 — at this 320 px viewport the history is the CARD LIST; the
        // table is `hidden` below `md`, so anchoring on it would never be
        // visible (and `.or()`-ing both would match two elements).
        p
          .getByTestId('broadcast-history-card-list')
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
      // The filter bar's `role="search"`, not the h1: since T086a V3 the
      // loading skeleton carries the page's own header (title AND actions),
      // so the h1 is on screen before the queue is — the scan would read the
      // skeleton. The skeleton's filter bar is an `aria-hidden` box.
      await scanScreen(page, testInfo, '/admin/broadcasts', (p) => p.getByRole('search'));
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

    /**
     * T155 finding U2 — § 15 item 1, and the thing the scan above CANNOT see:
     * **axe has no horizontal-scroll rule**, so screen 3 passed the WCAG pass
     * while overflowing 320 px in all three locales (measured 2026-09-22:
     * `scrollWidth` 565 vs `clientWidth` 305 in SV, 477 in EN, 337 in TH).
     * The queue header hand-rolled its action row instead of using
     * `PageHeader`'s `actions` prop, and `buttonVariants` bakes in
     * `whitespace-nowrap`, so two links sat on one unwrappable line.
     */
    test('T155 U2 — the staff queue has no horizontal scroll at 320 px', async ({
      page,
    }) => {
      await signInAsAdmin(page);
      await page.setViewportSize(REFLOW_VIEWPORT);
      await page.goto('/admin/broadcasts');
      // The settled queue, not its skeleton (see screen 3): both have the h1
      // and the header's action row, and the skeleton's is replaced mid-read.
      await expect(page.getByRole('search')).toBeVisible({ timeout: 120_000 });

      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      expect(
        scrollWidth,
        'no horizontal page scroll on the review queue at 320 px (WCAG 1.4.10)',
      ).toBeLessThanOrEqual(REFLOW_VIEWPORT.width);

      // …and the two header actions are on separate rows rather than one
      // overflowing line: the wrap is the mechanism, not a side effect.
      const actions = page.locator('[data-slot="page-header-actions"]:visible');
      await expect(actions).toBeVisible();
      const actionBox = await actions.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(
        actionBox!.width,
        'the action row fits inside the 320 px viewport',
      ).toBeLessThanOrEqual(REFLOW_VIEWPORT.width);
    });

    /**
     * F119 dashboard UX review B1 — the chip strip at 320 px in the two
     * locales with the longest new-stage labels. The U2 case above runs in EN,
     * where "Member approved — awaiting schedule" happens to fit; the SV
     * "Godkänt av medlem — inväntar schemaläggning" did not: the fieldset's
     * default `min-inline-size: min-content` and the two `role="group"` flex
     * rows' `min-width: auto` held the chip at its min-content width, so its
     * `truncate` never engaged.
     *
     * Needs the `member_approved` chip on screen — the approval-round flag on
     * (the maintainer's dev server), or a row in that stage. Asserted, not
     * assumed: without the chip this case would measure the short EN-length
     * strip and pass for the wrong reason.
     */
    /**
     * F119 dashboard UX review H4 — selecting a stage is announced through the
     * list's ONE live region, and the keyboard user stays on the chip they
     * pressed. The region survives the filter navigation only because the
     * `router.replace` runs inside `startTransition` (which suppresses the
     * `loading.tsx` fallback); a unit test's `rerender` cannot tell a preserved
     * region from a remounted one, so this runs against the real app.
     */
    test('H4 — a stage chip announces the new view and keeps focus on the chip', async ({
      page,
    }) => {
      await signInAsAdmin(page);
      await page.goto('/admin/broadcasts');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
        timeout: 120_000,
      });

      const announcer = page.locator('[data-testid="queue-selection-announcer"]:visible');
      await expect(announcer).toHaveCount(1);
      const sent = page.locator('input[name="status"][value="sent"]:visible');
      await expect(sent).not.toBeChecked();
      // Element identity, not only text: a region REMOUNTED by the navigation
      // (a `loading.tsx` swap) would carry the same text but lose this mark —
      // and a freshly mounted live region is not reliably announced.
      await announcer.evaluate((el) => {
        (el as HTMLElement).dataset['probe'] = 'kept';
      });

      // The keyboard path: focus the chip's checkbox, press Space.
      await sent.focus();
      await page.keyboard.press('Space');

      await expect(page).toHaveURL(/status=sent/, { timeout: 60_000 });
      await expect(sent).toBeChecked();
      await expect(announcer).toHaveText(
        /(?:No E-Blasts|\d+ E-Blasts?) in this view/,
        { timeout: 60_000 },
      );
      // Still exactly one region — the SAME element — and focus never left the chip.
      await expect(announcer).toHaveCount(1);
      await expect(announcer).toHaveAttribute('data-probe', 'kept');
      expect(
        await page.evaluate(() => {
          const el = document.activeElement;
          return el instanceof HTMLInputElement ? el.value : el?.tagName ?? null;
        }),
      ).toBe('sent');
    });

    for (const locale of ['sv', 'th'] as const) {
      test(`B1 — the ${locale.toUpperCase()} chip strip has no horizontal scroll at 320 px`, async ({
        page,
      }) => {
        await signInAsAdmin(page);
        // The locale cookie AFTER sign-in: the sign-in helper finds its fields
        // by their English labels.
        await page.context().addCookies([
          { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
        ]);
        await page.setViewportSize(REFLOW_VIEWPORT);
        await page.goto('/admin/broadcasts');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
          timeout: 120_000,
        });
        await expect(page.locator('html')).toHaveAttribute('lang', locale);

        const chip = page.locator(
          'input[name="status"][value="member_approved"]:visible',
        );
        await expect(
          chip,
          'the member_approved chip is absent — is FEATURE_EBLAST_MEMBER_APPROVAL on for this server?',
        ).toHaveCount(1);

        const scrollWidth = await page.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(
          scrollWidth,
          'no horizontal page scroll on the chip strip at 320 px (WCAG 1.4.10)',
        ).toBeLessThanOrEqual(REFLOW_VIEWPORT.width);

        // The strip itself, not only the document: an ancestor that clips
        // overflow would hide a chip that still runs off the edge.
        const fieldset = page.locator('fieldset:visible').filter({
          has: page.locator('input[name="status"]'),
        });
        const overflow = await fieldset.evaluate(
          (el) => el.scrollWidth - el.clientWidth,
        );
        expect(overflow, 'the Stage fieldset does not overflow').toBeLessThanOrEqual(0);
        const chipBox = await chip
          .locator('xpath=ancestor::label[1]')
          .boundingBox();
        expect(chipBox).not.toBeNull();
        expect(
          chipBox!.x + chipBox!.width,
          'the longest chip ends inside the viewport',
        ).toBeLessThanOrEqual(REFLOW_VIEWPORT.width);
      });
    }
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

/**
 * WCAG 1.4.10 by hand — axe has no horizontal-scroll rule (T155 U2), so a
 * clean scan says nothing about reflow. `scrollWidth` is the document's own
 * content width: an overflowing child widens it.
 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(
    scrollWidth,
    'no horizontal page scroll at 320 px (WCAG 1.4.10)',
  ).toBeLessThanOrEqual(REFLOW_VIEWPORT.width);
}

/**
 * WCAG 4.1.2 by hand for the frames the scan excludes (header note: axe cannot
 * enter a `sandbox=""` frame). Counted, not `.first()`: a screen that renders
 * one frame where it should render two would otherwise pass.
 */
async function expectFramesTitled(page: Page, expected: number): Promise<void> {
  const frames = page.locator('iframe[srcdoc]:visible');
  await expect(frames).toHaveCount(expected);
  for (let i = 0; i < expected; i++) {
    await expect(frames.nth(i)).toHaveAttribute('title', /.+/);
    await expect(frames.nth(i)).toHaveAttribute('sandbox', '');
  }
}

/**
 * F119 T086a (FR-051, US6) — the PR-2 half of the FR-051 pass: the same bar
 * T139 applied to PR-1's screens (zero serious or critical at 320 px, no
 * horizontal scroll), on the two screens PR-2 builds or changes that the block
 * above cannot reach in their approval shape:
 *
 *   - the staff format surface `/admin/broadcasts/[id]` (T063) in `in_design`,
 *     with the working copy open in the workspace;
 *   - the member sign-off view of `/portal/broadcasts/[id]` (T086) in
 *     `awaiting_member_approval`, with a sent version to compare.
 *
 * The stage is produced by the state machine (the UI flow marketing uses —
 * `helpers/eblast-approval-flow.ts`), and each anchor is an element only that
 * stage renders, awaited before axe runs: a scan of the pre-approval body view
 * under this test's name would be the wrong screen passing for the right one.
 *
 * Needs `FEATURE_EBLAST_MEMBER_APPROVAL=true` on the server (the flag gates the
 * first edge); without it the flow fails at "Start is absent", not skipped.
 *
 * The third PR-2 screen, the rebuilt queue, is screen 3 + U2 + B1 + H4 above.
 */
test.describe('@a11y F119 T086a — the approval screens PR-2 builds (320 px)', () => {
  test.skip(
    staffSkip || memberSkip,
    'Set E2E_ADMIN_EMAIL/PASSWORD and E2E_MEMBER_EMAIL_EMPTY/PASSWORD_EMPTY — both halves of the round are needed',
  );

  test('T086a — staff format surface /admin/broadcasts/[id] in in_design', async ({
    page,
  }, testInfo) => {
    await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
    const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
    expect(broadcastId, 'DATABASE_URL + E2E_MEMBER_EMAIL_EMPTY are required to seed the E-Blast').not.toBeNull();

    await startFormattedVersionAsMarketing(page, broadcastId!);

    // A fresh load at 320 px: the stage is server state, so it survives.
    await scanScreen(
      page,
      testInfo,
      `/admin/broadcasts/${broadcastId}`,
      (p) => p.locator('[data-testid="eblast-format-workspace"]:visible'),
      { exclude: 'iframe[srcdoc]' },
    );
    // It is marketing's turn — the in_design stage, not a read-only view.
    await expect(page.locator('[data-testid="eblast-whose-turn"]:visible')).toHaveText(/Marketing/);
    await expect(
      page.locator('[data-testid="eblast-format-workspace"]:visible [contenteditable="true"]'),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    // The member's original beside the working copy.
    await expect(page.locator('[data-testid="eblast-member-original"]:visible')).toBeVisible();
    const frames = await page.locator('iframe[srcdoc]:visible').count();
    expect(frames, 'the format surface renders at least one sandboxed preview').toBeGreaterThan(0);
    await expectFramesTitled(page, frames);
  });

  test('T086a — portal sign-off view /portal/broadcasts/[id] in awaiting_member_approval', async ({
    page,
    browser,
  }, testInfo) => {
    await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
    const broadcastId = await seedMemberDetailBroadcast(MEMBER_EMAIL);
    expect(broadcastId, 'DATABASE_URL + E2E_MEMBER_EMAIL_EMPTY are required to seed the E-Blast').not.toBeNull();

    // Marketing's half in its OWN context, so the member scan below runs on
    // the fixture `page` — the one carrying the pageerror net. The staff
    // page has no such net; a client error there would not fail this case.
    const staff = await browser.newContext();
    try {
      await formatAndSendAsMarketing(await staff.newPage(), broadcastId!, '[E2E] T086a sign-off scan');
    } finally {
      await staff.close();
    }

    await signInAsPortalMember(page);
    await scanScreen(
      page,
      testInfo,
      `/portal/broadcasts/${broadcastId}`,
      (p) => p.locator('[data-testid="eblast-formatted-version"]:visible'),
      { exclude: 'iframe[srcdoc]' },
    );
    // The sign-off actions render only while the member is being asked.
    await expect(page.locator('[data-testid="eblast-approve"]:visible')).toBeVisible();
    await expect(page.locator('[data-testid="eblast-member-original"]:visible')).toBeVisible();
    await expectNoHorizontalScroll(page);
    // FR-008: the formatted version and the original, each in its own frame.
    await expectFramesTitled(page, 2);
  });
});
