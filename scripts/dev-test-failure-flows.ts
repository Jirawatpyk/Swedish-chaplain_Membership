/**
 * DEV-ONLY empirical test runner for F5 submit-failure localization
 * matrix. Iterates Stripe test cards that trigger distinct
 * `decline_code`s and asserts the drawer's retry-panel body.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/dev-test-failure-flows.ts
 *
 * Prereqs:
 *   - dev server on :3100
 *   - invoice b070ff99 in `issued` state (reset via
 *     `dev-reset-invoice-to-issued.ts` if needed)
 *   - E2E member creds in .env.local
 */
import { chromium, type Page, type FrameLocator } from 'playwright';

const BASE = 'http://localhost:3100';
const INVOICE = 'b070ff99-e7f1-48c4-a87c-f04cada85036';
const EMAIL = process.env.E2E_MEMBER_EMAIL ?? 'e2e-member@swecham.test';
const PW = process.env.E2E_MEMBER_PASSWORD ?? 'E2E-Testing-Password-2026!xZ';

interface TestCase {
  readonly name: string;
  readonly card: string;
  readonly expectedContains: string;
}

const CASES: readonly TestCase[] = [
  { name: 'card_declined', card: '4000000000000002', expectedContains: 'was declined' },
  { name: 'insufficient_funds', card: '4000000000009995', expectedContains: 'insufficient funds' },
  { name: 'expired_card', card: '4000000000000069', expectedContains: 'has expired' },
  { name: 'incorrect_cvc', card: '4000000000000127', expectedContains: 'security code is incorrect' },
  { name: 'processing_error', card: '4000000000000119', expectedContains: 'error occurred while processing' },
];

async function signIn(page: Page) {
  await page.goto(`${BASE}/portal/invoices/${INVOICE}`);
  await page.waitForLoadState('domcontentloaded');
  if (page.url().includes('sign-in')) {
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PW);
    await page.click('button[type=submit]');
    await page.waitForURL(url => !url.href.includes('sign-in'), { timeout: 10_000 });
  }
}

async function openDrawer(page: Page) {
  await page.getByTestId('pay-now-button').first().click();
  // Wait for card form ready: security footer is gated on form visibility
  await page.waitForSelector('[data-testid="pay-sheet-security-footer"]', { timeout: 30_000 });
}

async function fillCard(page: Page, cardNum: string) {
  const frame: FrameLocator = page.frameLocator('[data-testid="pay-sheet-content"] iframe').first();
  await frame.getByRole('textbox', { name: 'Card number' }).fill(cardNum);
  await frame.getByRole('textbox', { name: 'Expiration date MM / YY' }).fill('1234');
  await frame.getByRole('textbox', { name: 'Security code' }).fill('123');
}

async function submitAndGetRetryText(page: Page): Promise<string> {
  await page.getByTestId('pay-sheet-card-submit').click();
  await page.waitForSelector('[data-testid="pay-sheet-retry-panel"]', { timeout: 30_000 });
  const text = await page.locator('[data-testid="pay-sheet-retry-panel"]').textContent();
  return text ?? '';
}

async function clickRetry(page: Page) {
  await page.getByTestId('pay-sheet-retry-cta').click();
  await page.waitForSelector('[data-testid="pay-sheet-security-footer"]', { timeout: 30_000 });
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const results: Array<{ name: string; pass: boolean; text: string }> = [];

  try {
    await signIn(page);
    await openDrawer(page);

    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i]!;
      await fillCard(page, c.card);
      const text = await submitAndGetRetryText(page);
      const pass = text.toLowerCase().includes(c.expectedContains.toLowerCase());
      results.push({ name: c.name, pass, text: text.slice(0, 150) });
      console.log(`${pass ? '✓' : '✗'} ${c.name}: ${text.slice(0, 100)}`);
      if (i < CASES.length - 1) {
        await clickRetry(page);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== RESULTS ===');
  console.table(results);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`${failed.length} failure(s)`);
    process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
