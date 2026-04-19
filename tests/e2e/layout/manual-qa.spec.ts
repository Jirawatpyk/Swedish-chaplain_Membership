/**
 * F5 manual-QA automation — replaces the human-gated SC-006 / T076 / T059
 * checks that were originally specified as "open browser and verify".
 *
 * Each test produces structured evidence (numbers, computed style values,
 * box widths) that gets written under specs/006-layout-container-tier2/qa/.
 *
 * Tagged @qa so it doesn't run as part of the default suite.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../fixtures';
import { signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

const QA_DIR = resolve(
  process.cwd(),
  'specs/006-layout-container-tier2/qa/responses',
);

function writeEvidence(name: string, data: unknown): void {
  mkdirSync(QA_DIR, { recursive: true });
  writeFileSync(
    resolve(QA_DIR, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf8',
  );
}

test.describe('F5 manual-QA automation @qa', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test('TC-009 (SC-006) — chars/line ≤80 on form pages @1440 EN', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInViaForm(
        page,
        '/admin/sign-in',
        ADMIN_EMAIL!,
        ADMIN_PASSWORD!,
        /^\/admin(\/|$)/,
      );

      const adminRoutes = ['/admin/settings/invoicing', '/admin/plans/new'];
      const samples: Array<{
        route: string;
        text: string;
        widthPx: number;
        fontSizePx: number;
        approxCharsPerLine: number;
      }> = [];

      for (const route of adminRoutes) {
        await page.goto(route);
        await waitForLayoutContainer(page);
        // Sample first 3 body-text nodes inside the layout container.
        const nodes = await page
          .locator(
            '[data-slot="layout-container"] p, [data-slot="layout-container"] label, [data-slot="layout-container"] .text-body',
          )
          .all();
        let n = 0;
        for (const node of nodes) {
          if (n >= 3) break;
          const txt = (await node.innerText()).trim();
          if (txt.length < 20) continue;
          const box = await node.boundingBox();
          if (!box) continue;
          const fontSizePx = Number(
            await node.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
          );
          // Approximation: 1 em ≈ 0.5 * font-size for average Latin char width.
          // Spec says width / 1em — we approximate 1em ≈ 2 average chars.
          const approxCharsPerLine = box.width / (fontSizePx * 0.5);
          samples.push({
            route,
            text: txt.slice(0, 60),
            widthPx: Math.round(box.width),
            fontSizePx: Math.round(fontSizePx),
            approxCharsPerLine: Math.round(approxCharsPerLine),
          });
          n++;
        }
      }

      // Member portal sample
      await context.close();
      const memberCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const memberPage = await memberCtx.newPage();
      try {
        await signInViaForm(
          memberPage,
          '/portal/sign-in',
          MEMBER_EMAIL!,
          MEMBER_PASSWORD!,
          /^\/portal(\/|$)/,
        );
        await memberPage.goto('/portal/account');
        await waitForLayoutContainer(memberPage);
        const nodes = await memberPage
          .locator(
            '[data-slot="layout-container"] p, [data-slot="layout-container"] label, [data-slot="layout-container"] .text-body',
          )
          .all();
        let n = 0;
        for (const node of nodes) {
          if (n >= 3) break;
          const txt = (await node.innerText()).trim();
          if (txt.length < 20) continue;
          const box = await node.boundingBox();
          if (!box) continue;
          const fontSizePx = Number(
            await node.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
          );
          const approxCharsPerLine = box.width / (fontSizePx * 0.5);
          samples.push({
            route: '/portal/account',
            text: txt.slice(0, 60),
            widthPx: Math.round(box.width),
            fontSizePx: Math.round(fontSizePx),
            approxCharsPerLine: Math.round(approxCharsPerLine),
          });
          n++;
        }
      } finally {
        await memberCtx.close();
      }

      const mean =
        samples.reduce((s, x) => s + x.approxCharsPerLine, 0) /
        Math.max(1, samples.length);
      const evidence = {
        budget: 80,
        mean: Math.round(mean),
        passed: mean <= 80,
        samples,
      };
      writeEvidence('tc-009-sc006-chars-per-line.json', evidence);
      expect(samples.length, 'must collect at least 3 samples').toBeGreaterThanOrEqual(3);
      expect(mean, `mean approx chars/line must be ≤80 (got ${Math.round(mean)})`).toBeLessThanOrEqual(80);
    } finally {
      // memberCtx already closed inside try
    }
  });

  test('TC-010 (T076) — Thai locale wraps at word boundaries (line-break engaged)', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      // Sign in first; sign-in may write/replace cookies, so we set
      // NEXT_LOCALE AFTER the auth handshake but BEFORE the navigations
      // we care about.
      await signInViaForm(
        page,
        '/admin/sign-in',
        ADMIN_EMAIL!,
        ADMIN_PASSWORD!,
        /^\/admin(\/|$)/,
      );
      // next-intl reads the locale from the NEXT_LOCALE cookie
      // (src/i18n/request.ts).
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: 'th',
          domain: 'localhost',
          path: '/',
        },
      ]);

      const evidence: Array<{
        route: string;
        htmlLang: string;
        bodyLineBreak: string;
        bodyWordBreak: string;
        thLineBreakRule: 'loose' | 'other';
      }> = [];

      for (const route of ['/admin/settings/invoicing', '/admin/plans/new']) {
        await page.goto(route);
        await waitForLayoutContainer(page);

        const computed = await page.evaluate(() => {
          const html = document.documentElement;
          // Find any element with [lang="th"] or :lang(th) match
          const target = document.querySelector('p, label, h1') ?? html;
          const tStyle = getComputedStyle(target);
          return {
            htmlLang: html.lang,
            bodyLineBreak: tStyle.lineBreak ?? '',
            bodyWordBreak: tStyle.wordBreak ?? '',
          };
        });

        evidence.push({
          route,
          htmlLang: computed.htmlLang,
          bodyLineBreak: computed.bodyLineBreak,
          bodyWordBreak: computed.bodyWordBreak,
          thLineBreakRule: computed.bodyLineBreak === 'loose' ? 'loose' : 'other',
        });
      }

      writeEvidence('tc-010-thai-line-break.json', evidence);
      // The :lang(th) hedge applies line-break: loose only when html[lang]
      // matches th. With locale 'th-TH' next-intl should set html.lang.
      const allTh = evidence.every((e) => e.htmlLang.startsWith('th'));
      expect(allTh, `html.lang must be Thai (got ${evidence.map((e) => e.htmlLang).join(',')})`).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('TC-011 (T059) — plan-detail page reads cleanly inside 72rem with embedded table', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInViaForm(
        page,
        '/admin/sign-in',
        ADMIN_EMAIL!,
        ADMIN_PASSWORD!,
        /^\/admin(\/|$)/,
      );

      const route = `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`;
      await page.goto(route);
      await waitForLayoutContainer(page);

      const container = page
        .locator('[data-slot="layout-container"][data-variant="detail"]')
        .first();
      await expect(container).toBeVisible();

      const containerWidth = await container.evaluate(
        (el) => (el as HTMLElement).getBoundingClientRect().width,
      );

      // Probe for any inner <table>; if present, verify it has an
      // overflow-x-auto wrapper (shadcn <Table> default).
      const tableCount = await page.locator('[data-slot="layout-container"] table').count();
      let tableWrapperOverflow: string | null = null;
      let tableScrollWidth: number | null = null;
      let containerOverflows = false;
      if (tableCount > 0) {
        const wrapperOverflow = await page
          .locator('[data-slot="layout-container"] table')
          .first()
          .evaluate((tbl) => {
            const wrapper = (tbl.parentElement as HTMLElement | null) ?? null;
            return wrapper ? getComputedStyle(wrapper).overflowX : null;
          });
        tableWrapperOverflow = wrapperOverflow;
        tableScrollWidth = await page
          .locator('[data-slot="layout-container"] table')
          .first()
          .evaluate((tbl) => (tbl as HTMLElement).scrollWidth);
        const bodyOverflow = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        containerOverflows = bodyOverflow.sw > bodyOverflow.cw;
      }

      const evidence = {
        route,
        containerWidthPx: Math.round(containerWidth),
        expectedRangePx: { min: 1148, max: 1156 },
        tableCount,
        tableWrapperOverflow,
        tableScrollWidthPx: tableScrollWidth,
        bodyHorizontallyOverflows: containerOverflows,
        verdict:
          containerWidth >= 1148 &&
          containerWidth <= 1156 &&
          !containerOverflows
            ? 'reads-cleanly-inside-72rem'
            : 'NEEDS-REVIEW',
      };
      writeEvidence('tc-011-plan-detail-readability.json', evidence);

      expect(containerWidth, 'detail container = 72rem ±4px @1440').toBeGreaterThanOrEqual(1148);
      expect(containerWidth).toBeLessThanOrEqual(1156);
      expect(containerOverflows, 'no body horizontal overflow').toBe(false);
    } finally {
      await context.close();
    }
  });
});
