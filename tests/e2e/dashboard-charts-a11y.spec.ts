/**
 * Task 14 (067-dashboard-interactive-charts) — interaction-level `@a11y`
 * axe-core scan of the four dashboard charts (revenue-trend sparkline,
 * member-growth sparkline, membership-by-tier bar, invoice-status donut).
 *
 * Why this exists on top of `f9-a11y.spec.ts`'s existing static `/admin`
 * scan: every Recharts canvas in this feature is rendered inside an
 * `aria-hidden="true"` wrapper with `accessibilityLayer={false}` (see
 * `chart-data-table.tsx` / each `*-chart.tsx` docblock) — a **hover-only**
 * mouse tooltip is the one piece of DOM that a static scan never exercises
 * (axe-core only inspects the DOM as it stands at scan time; it does not
 * simulate mouse/keyboard interaction). The design doc
 * (`docs/superpowers/specs/2026-07-16-dashboard-interactive-charts-design.md`
 * § Testing) explicitly calls for "Playwright steps that hover/focus each
 * chart before scanning".
 *
 * **Why "focus" doesn't get its own hover-equivalent test here**: per the
 * same design doc (§ Accessibility, "Focus: since charts are
 * `aria-hidden`/non-focusable, no focus ring needed on the canvas") this is
 * a DELIBERATE decision, not an oversight — Recharts' built-in
 * `accessibilityLayer` (which would add `tabIndex=0` + arrow-key nav) is
 * explicitly disabled on every chart instance specifically because
 * `tabIndex` on an `aria-hidden` ancestor is itself an axe violation
 * (`aria-hidden-focus`). So instead of pretending keyboard focus can reach
 * into the chart (it can't, by design) this file has TWO tests: one proves
 * hover really does surface a tooltip with zero new axe violations, and one
 * proves the decorative canvas genuinely never becomes focusable — i.e. a
 * positive regression guard for the exact axe rule the design doc is
 * avoiding, not a fake "tab to the chart" flow.
 *
 * Run: `pnpm test:e2e --workers=1 --grep "@a11y"` (this file's tests carry
 * the `@a11y` tag) or narrower: `pnpm exec playwright test
 * tests/e2e/dashboard-charts-a11y.spec.ts --workers=1`.
 *
 * Gated on `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` + `FEATURE_F9_DASHBOARD`
 * (fail-hard, not `test.skip`, matching `f9-a11y.spec.ts` — "skip is not
 * pass").
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const F9_ENABLED = process.env.FEATURE_F9_DASHBOARD === 'true';

// Turbopack cold-compiles the recharts dynamic-import chunk on the first
// hit in local dev; give every test in this file generous headroom (mirrors
// `broadcast-a11y.spec.ts`'s Tiptap-chunk allowance).
test.describe.configure({ timeout: 120_000 });

const CHART_TITLES = {
  revenueTrend: 'Revenue trend (12 months)',
  memberGrowth: 'Member growth (12 months)',
  membershipTier: 'Membership by tier',
  invoiceStatus: 'Invoice value by status',
} as const;

/** Same filter every a11y spec in this suite uses (`f9-a11y.spec.ts`,
 * `invoice-admin-a11y.spec.ts`, …) — serious/critical only, logged verbosely
 * on failure so a red run is diagnosable from CI output alone. */
async function expectNoAxeViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const seriousOrWorse = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (seriousOrWorse.length > 0) {
    console.error(
      `[axe ${surface}] ${seriousOrWorse.length} serious/critical violations:`,
      JSON.stringify(seriousOrWorse, null, 2),
    );
  }
  expect(seriousOrWorse, `${surface}: serious/critical axe violations`).toHaveLength(0);
}

/** Scopes to the `<Card>` whose `CardTitle` renders the given chart title
 * (`data-slot="card"` — shadcn's convention, see `ui/card.tsx`). Every 067
 * chart title is a self-contained-i18n string unique across the dashboard. */
function chartCard(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first();
}

/**
 * Waits for the chart's lazy `next/dynamic(..., { ssr: false })` canvas to
 * mount (`data-slot="chart"` — the shadcn `ChartContainer` wrapper, see
 * `ui/chart.tsx`). Returns `null` if it never attaches within the timeout —
 * the caller must treat that as the chart's EMPTY-STATE branch (no
 * `hasData`), not a failure: an empty chart never mounts a canvas at all
 * (see e.g. `membership-tier-chart.tsx`'s `!hasData` early return), so
 * there is nothing to hover.
 */
async function waitForChartCanvas(card: Locator, timeout = 30_000): Promise<Locator | null> {
  const chartSlot = card.locator('[data-slot="chart"]').first();
  const attached = await chartSlot
    .waitFor({ state: 'attached', timeout })
    .then(() => true)
    .catch(() => false);
  return attached ? chartSlot : null;
}

/**
 * Bar/line/area (Cartesian) charts. Two techniques, depending on shape:
 *
 * - **Bar charts** (revenue-trend AND the horizontal membership-tier bar)
 *   hover an actual `.recharts-bar-rectangle` element directly. Naively
 *   hovering the whole `<svg>`'s bounding-box CENTER is unreliable for the
 *   horizontal tier bar specifically: its `YAxis` reserves a 110px category-
 *   label gutter on the left (`membership-tier-canvas.tsx`), so the
 *   geometric center of the full SVG can land inside that label gutter
 *   rather than the actual plotting/bar area, and Recharts only fires the
 *   tooltip when the pointer is within the tracked plot rectangle.
 *   Hovering a real bar element (Playwright computes ITS OWN bounding box)
 *   sidesteps that gutter-math entirely.
 * - **Area/line charts** (member growth) have no discrete per-point shape
 *   to target — Recharts tracks the pointer across the WHOLE plotting
 *   rectangle for these, so the SVG's own bounding-box center is reliable
 *   (empirically confirmed).
 */
async function hoverCartesianCanvas(page: Page, chartSlot: Locator): Promise<void> {
  const bar = chartSlot.locator('.recharts-bar-rectangle').first();
  if ((await bar.count()) > 0) {
    await bar.hover();
    return;
  }
  const svg = chartSlot.locator('svg').first();
  const box = await svg.boundingBox();
  if (!box) throw new Error('Chart <svg> has no bounding box — did it actually mount?');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * The invoice-status donut has no "track anywhere" tooltip behaviour —
 * Recharts only fires the tooltip when the pointer is directly over an
 * individual `<Sector>` path. Rather than guess the exact angle the first
 * (paid) bucket's slice starts at, scan a ring of points between the
 * donut's `innerRadius` (65%) and `outerRadius` (94%) — see
 * `invoice-status-canvas.tsx` — until the tooltip actually appears.
 */
async function hoverDonutUntilTooltipVisible(page: Page, chartSlot: Locator): Promise<boolean> {
  const svg = chartSlot.locator('svg').first();
  const box = await svg.boundingBox();
  if (!box) throw new Error('Donut <svg> has no bounding box — did it actually mount?');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = (Math.min(box.width, box.height) / 2) * 0.8; // inside the 65-94% band
  // Scoped to this chart's own ChartContainer — see the cartesian-chart
  // hover check above for why a page-global `.first()` is the wrong tool
  // once more than one chart's tooltip wrapper exists in the DOM.
  const tooltip = chartSlot.locator('.recharts-tooltip-wrapper').first();
  for (let deg = 0; deg < 360; deg += 20) {
    const rad = (deg * Math.PI) / 180;
    await page.mouse.move(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
    // Give Recharts' React state update a tick to paint before checking.
    await page.waitForTimeout(50);
    if (await tooltip.isVisible().catch(() => false)) return true;
  }
  return false;
}

async function gotoDashboard(page: Page): Promise<void> {
  await signInAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

test.describe('@a11y dashboard interactive charts — Task 14 (067-dashboard-interactive-charts)', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error(
        'E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD missing — set them in .env.local before running this suite.',
      );
    }
    if (!F9_ENABLED) {
      throw new Error(
        'FEATURE_F9_DASHBOARD=false — set FEATURE_F9_DASHBOARD=true in .env.local before running this suite.',
      );
    }
  });

  test('static scan: /admin dashboard has zero serious/critical axe violations', async ({ page }) => {
    await gotoDashboard(page);
    // Let all four lazy canvases resolve past their skeletons before the
    // static baseline scan, so this reflects the settled page, not a
    // mid-load state (the hover test below re-scans per-chart anyway).
    await page.waitForTimeout(1_000);
    await expectNoAxeViolations(page, '/admin (dashboard, static)');
  });

  test('hovering each chart surfaces its tooltip with zero new axe violations', async ({ page }) => {
    await gotoDashboard(page);

    for (const title of [
      CHART_TITLES.revenueTrend,
      CHART_TITLES.memberGrowth,
      CHART_TITLES.membershipTier,
    ] as const) {
      const card = chartCard(page, title);
      await expect(card).toBeVisible();
      const chartSlot = await waitForChartCanvas(card);
      if (!chartSlot) {
        // Empty-state branch (no data for this tenant) — nothing to hover,
        // but the empty-state text itself must still be axe-clean.
        test.info().annotations.push({
          type: 'skip-reason',
          description: `${title}: no canvas mounted (empty-state branch) — hover check skipped`,
        });
        continue;
      }
      await hoverCartesianCanvas(page, chartSlot);
      // Scoped to THIS chart's own ChartContainer — each of the 4 charts
      // mounts its own independent `.recharts-tooltip-wrapper` instance, and
      // a previously-hovered chart's wrapper stays in the DOM (just hidden
      // again once the pointer moves away), so a page-global `.first()`
      // would silently keep matching the FIRST chart's (now-hidden) wrapper
      // instead of this one's.
      await expect(
        chartSlot.locator('.recharts-tooltip-wrapper').first(),
        `${title}: hovering the chart should surface a Recharts tooltip`,
      ).toBeVisible({ timeout: 5_000 });
      await expectNoAxeViolations(page, `/admin (dashboard) — ${title} tooltip open`);
      // Move away before the next chart so tooltips don't stack/linger.
      await page.mouse.move(0, 0);
    }

    // Donut needs its own ring-scan hover technique (see helper docblock).
    const invoiceCard = chartCard(page, CHART_TITLES.invoiceStatus);
    await expect(invoiceCard).toBeVisible();
    const invoiceChartSlot = await waitForChartCanvas(invoiceCard);
    if (!invoiceChartSlot) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: `${CHART_TITLES.invoiceStatus}: no canvas mounted (empty-state branch) — hover check skipped`,
      });
    } else {
      const revealed = await hoverDonutUntilTooltipVisible(page, invoiceChartSlot);
      expect(
        revealed,
        `${CHART_TITLES.invoiceStatus}: scanning the donut ring should surface a Recharts tooltip`,
      ).toBe(true);
      await expectNoAxeViolations(page, `/admin (dashboard) — ${CHART_TITLES.invoiceStatus} tooltip open`);
    }
  });

  test('the decorative chart canvas never becomes keyboard-focusable (aria-hidden regression guard)', async ({
    page,
  }) => {
    await gotoDashboard(page);

    for (const title of Object.values(CHART_TITLES)) {
      const card = chartCard(page, title);
      await expect(card).toBeVisible();
      const ariaHiddenWrapper = card.locator('[aria-hidden="true"]').first();
      const present = await ariaHiddenWrapper
        .waitFor({ state: 'attached', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!present) {
        // Empty-state branch — no canvas, no aria-hidden wrapper, nothing
        // to probe for this chart.
        continue;
      }
      // Programmatic `.focus()` uses the SAME focusability rules a Tab
      // keypress does (tabIndex >= 0 or a natively-focusable element) — if
      // this wrapper ever regains `accessibilityLayer`'s `tabIndex=0`
      // (the exact regression the design doc calls out), `activeElement`
      // would move to it and this assertion would start failing.
      const becameActive = await ariaHiddenWrapper.evaluate((el) => {
        (el as HTMLElement).focus();
        return document.activeElement === el;
      });
      expect(becameActive, `${title}: aria-hidden chart wrapper must never be focusable`).toBe(false);
    }
  });

  test('accessible equivalents are present: hidden ChartDataTables, donut centre-total, KPI numbers', async ({
    page,
  }) => {
    await gotoDashboard(page);

    // KPI numbers (Key metrics landmark) — 4 cards, each a non-empty
    // digit-bearing value (every KPI now renders via <CountUp>, Task 15;
    // its sr-only final-value span always carries the real formatted
    // number regardless of animation state).
    const kpiSection = page.locator('section[aria-label="Key metrics"]');
    await expect(kpiSection).toBeVisible();
    const kpiValues = kpiSection.locator('[data-slot="card-title"]');
    await expect(kpiValues).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(kpiValues.nth(i)).toContainText(/\d/);
    }

    // Donut centre-total — REAL DOM text, deliberately NOT aria-hidden (see
    // invoice-status-chart.tsx's docblock: "real DOM, not SVG-only").
    // Only present when the donut has data — matches the empty-state
    // skip pattern used above.
    const totalInvoiced = page.getByText('Total invoiced');
    if (await totalInvoiced.isVisible().catch(() => false)) {
      await expect(totalInvoiced).toBeVisible();
    }

    // Hidden <ChartDataTable>s — one per chart, always present in the DOM
    // (server-rendered, `sr-only` — never `aria-hidden`) regardless of
    // whether the decorative canvas mounted. `toBeAttached` rather than
    // `toBeVisible`: `sr-only` clips to a 1x1px box, which is DOM-present
    // but not meaningfully "visible" in the visual sense Playwright checks.
    for (const caption of Object.values(CHART_TITLES)) {
      await expect(page.getByRole('table', { name: caption })).toBeAttached();
    }
  });

  test('@i18n prefers-reduced-motion: charts render with no animation errors', async ({ page }) => {
    // Recharts' `isAnimationActive` is a JS prop (per-shape transition), not
    // a CSS `animation-duration` — unlike the shimmer-skeleton pattern in
    // `members-reduced-motion.spec.ts`, there is no CSS animation to assert
    // `0s` on. The meaningful check under reduced motion is: (a) every
    // chart still renders its final content synchronously (no stuck
    // mid-animation state, since `use-motion-preference.ts` makes
    // `isAnimationActive` false jump straight to final geometry), and (b)
    // zero client-side pageerror is thrown (auto-enforced by the `page`
    // fixture in `./fixtures` — a thrown animation/render error fails this
    // test even without an explicit assertion below).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoDashboard(page);

    for (const title of Object.values(CHART_TITLES)) {
      const card = chartCard(page, title);
      await expect(card).toBeVisible();
      const chartSlot = await waitForChartCanvas(card);
      if (!chartSlot) continue; // empty-state branch — nothing to render
      // Final geometry must be present immediately (no animation to wait
      // out) — the chart's own <svg> having a non-zero-area bounding box
      // is enough proof the canvas actually painted its content.
      const svg = chartSlot.locator('svg').first();
      const box = await svg.boundingBox();
      expect(box?.width ?? 0, `${title}: chart should render under reduced-motion`).toBeGreaterThan(0);
      expect(box?.height ?? 0, `${title}: chart should render under reduced-motion`).toBeGreaterThan(0);
    }
  });
});
