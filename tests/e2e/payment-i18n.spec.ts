/**
 * T145 — F5 i18n locale coverage E2E.
 *
 * @f5 @i18n
 *
 * Spec authority:
 *   - plan.md § V i18n (EN+TH+SV at release)
 *   - spec.md FR-022 (Stripe Elements `locale='th'` for Thai card form)
 *   - data-model.md § F5 audit events (top-20 decline-code translations)
 *
 * For each of EN / TH / SV:
 *   1. No raw translation key (`portal.payment.*` / `admin.refund.*`) leaks
 *      into the DOM on the F5-bearing surfaces.
 *   2. Stripe Elements `locale` prop matches the next-intl active locale
 *      (FR-022: when the user is on `/portal` with `NEXT_LOCALE=th`, the
 *      Stripe iframe MUST be `locale=th` so card-form labels render in Thai).
 *   3. R2-E2 truncation: Thai card-form labels do NOT truncate within the
 *      drawer's narrow column at < sm breakpoint.
 *   4. Decline-code translation registry exists for EN/TH/SV (file-system
 *      invariant on i18n catalogues).
 *
 * Gating mirrors `payment-a11y.spec.ts` — env-var fixtures.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { memberTest as test, expect } from './helpers/member-session';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;
const isCi = process.env.CI === 'true' || process.env.CI === '1';

const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];

async function setLocale(
  context: BrowserContext,
  locale: Locale,
): Promise<void> {
  await context.addCookies([
    {
      name: 'NEXT_LOCALE',
      value: locale,
      url: 'http://localhost:3100',
    },
  ]);
}

/**
 * Detect raw next-intl key leaks in the rendered DOM. A leak looks like
 * `portal.payment.foo.bar` — three or more dot-separated segments where
 * EVERY segment is identifier-like. False-positive guard: skip strings
 * that look like file paths or URLs (heuristics tuned per project
 * convention in members-i18n.spec.ts).
 */
function findKeyLeaks(text: string): string[] {
  const candidates = text.match(
    /\b(portal|admin|common|payments|refunds)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}\b/g,
  );
  if (!candidates) return [];
  return candidates.filter((c) => !c.includes('/') && !c.includes('@'));
}

test.describe('F5 i18n locale coverage @f5 @i18n @e2e (T145)', () => {
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error(
        '[T145 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI.',
      );
    }
    test.skip(
      true,
      'E2E_ISSUED_INVOICE_ID missing — local skip; CI throws above.',
    );
  }

  for (const locale of LOCALES) {
    test(`portal invoice detail renders cleanly under NEXT_LOCALE=${locale}`, async ({
      page,
      context,
    }) => {
      await setLocale(context, locale);
      await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}`);
      await page.waitForLoadState('networkidle');

      const bodyText = (await page.locator('body').innerText()) ?? '';
      const leaks = findKeyLeaks(bodyText);
      expect(
        leaks,
        `${locale}: ${leaks.length} raw i18n key leak(s): ${leaks.slice(0, 3).join(', ')}`,
      ).toEqual([]);
    });

    test(`PaySheet drawer renders cleanly under NEXT_LOCALE=${locale}`, async ({
      page,
      context,
    }) => {
      await setLocale(context, locale);
      await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
      await page.waitForSelector('[data-testid="pay-sheet-content"]', {
        state: 'visible',
        timeout: 10_000,
      });
      // Wait for the lazy-loaded card form to mount so all
      // localised strings are in the DOM before the leak scan.
      await page.waitForSelector(
        '[data-testid="pay-sheet-card-form-wrapper"]',
        { state: 'visible', timeout: 15_000 },
      );
      await page.waitForLoadState('networkidle');

      const drawerText =
        (await page.locator('[data-testid="pay-sheet-content"]').innerText()) ?? '';
      const leaks = findKeyLeaks(drawerText);
      expect(leaks).toEqual([]);
    });
  }

  test('Stripe Elements locale prop matches NEXT_LOCALE=th (FR-022)', async ({
    page,
    context,
  }) => {
    await setLocale(context, 'th');
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    await page.waitForSelector('[data-testid="pay-sheet-content"]', {
      state: 'visible',
      timeout: 10_000,
    });
    await page.waitForSelector('[data-testid="pay-sheet-card-form-wrapper"]', {
      state: 'visible',
      timeout: 15_000,
    });
    // Stripe Elements iframe URL embeds `locale=th` when the parent
    // <Elements> provider is initialised with `locale='th'`. Match
    // against any iframe whose `src` originates from js.stripe.com.
    const iframeUrls = await page
      .locator('iframe[src*="js.stripe.com"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLIFrameElement).src));
    expect(
      iframeUrls.length,
      'Stripe Elements iframe(s) must load on the card tab',
    ).toBeGreaterThan(0);
    const allHaveThaiLocale = iframeUrls.every((url) =>
      /[?&]locale=th\b/.test(url),
    );
    expect(
      allHaveThaiLocale,
      `Stripe iframe(s) under NEXT_LOCALE=th MUST carry ?locale=th — got: ${iframeUrls.join(', ')}`,
    ).toBe(true);
  });

  test('R2-E2 Thai card-form labels do not horizontally truncate at narrow viewport', async ({
    page,
    context,
  }) => {
    await setLocale(context, 'th');
    await page.setViewportSize({ width: 360, height: 760 }); // sm breakpoint
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    await page.waitForSelector('[data-testid="pay-sheet-content"]', {
      state: 'visible',
      timeout: 10_000,
    });
    await page.waitForSelector('[data-testid="pay-sheet-card-form-wrapper"]', {
      state: 'visible',
      timeout: 15_000,
    });

    // Heuristic: walk all label-shaped elements inside the drawer and
    // check `scrollWidth > clientWidth + 2` (truncation signal). The
    // +2 tolerance covers sub-pixel rounding on high-DPI displays.
    const truncated = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="pay-sheet-content"]');
      if (!drawer) return [];
      const labels = drawer.querySelectorAll('label, .label, [data-testid$="label"]');
      const truncatedTexts: string[] = [];
      labels.forEach((el) => {
        const html = el as HTMLElement;
        if (html.scrollWidth > html.clientWidth + 2) {
          truncatedTexts.push(html.textContent?.trim() ?? '');
        }
      });
      return truncatedTexts;
    });
    expect(
      truncated,
      `R2-E2: Thai card-form labels truncated at sm breakpoint: ${truncated.join(' | ')}`,
    ).toEqual([]);
  });

  test('decline-code translation catalogues exist for EN+TH+SV', () => {
    // File-system invariant: every locale's messages must declare the
    // `decline_codes` namespace so a Stripe failure renders the
    // user-facing reason in the active locale (FR-022 + observability
    // dashboard reason_code labels).
    const cwd = process.cwd();
    const localePaths = LOCALES.map((l) =>
      join(cwd, `src/i18n/messages/${l}.json`),
    );
    const missing: string[] = [];
    const reportedSizes: Record<string, number> = {};
    for (let i = 0; i < LOCALES.length; i += 1) {
      const locale = LOCALES[i]!;
      const path = localePaths[i]!;
      if (!existsSync(path)) {
        missing.push(`${locale} (${path} not found)`);
        continue;
      }
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<
          string,
          unknown
        >;
        // Decline-code namespace can live under any of these keys
        // depending on how the i18n tree was sliced. Accept the first
        // hit. Spec target ≥ 20 entries (top-20 decline codes).
        const candidates = [
          (raw['decline_codes'] as Record<string, unknown> | undefined),
          ((raw['payments'] as Record<string, unknown> | undefined)
            ?.['decline_codes']) as Record<string, unknown> | undefined,
          ((raw['portal'] as Record<string, unknown> | undefined)
            ?.['payment'] as Record<string, unknown> | undefined)?.[
            'decline_codes'
          ] as Record<string, unknown> | undefined,
        ];
        const found = candidates.find((c) => c && Object.keys(c).length > 0);
        if (!found) {
          missing.push(`${locale} (no decline_codes namespace under any of decline_codes / payments.decline_codes / portal.payment.decline_codes)`);
        } else {
          reportedSizes[locale] = Object.keys(found).length;
        }
      } catch (e) {
        missing.push(
          `${locale} (parse failed: ${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    expect(
      missing,
      `Locales missing decline-code namespace: ${missing.join('; ')}. Found sizes: ${JSON.stringify(reportedSizes)}`,
    ).toEqual([]);
  });
});
