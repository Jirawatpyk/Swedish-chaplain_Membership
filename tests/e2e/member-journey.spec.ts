/**
 * Golden-path JOURNEY E2E — MEMBER persona (self-service) (docs/go-live-readiness.md § 4 Stage 1b + § 7).
 *
 * Walks the member self-service journey end-to-end across module seams:
 *   sign-in (F1) → view invoices + pay (F4/F5) → update profile (F3) → view plan + tier
 *   benefits (F9) → request GDPR export (F9).
 *
 * The invitation → set-password leg is covered by the F1 invite specs (it needs a one-time
 * invitation token that the seeded e2e-member has already consumed); this journey starts at
 * sign-in with the seeded portal account. The renewal-reminder and broadcast-unsubscribe legs
 * are token/link-gated PUBLIC flows (a signed renewal link / unsubscribe token) and are
 * covered by their own dedicated specs rather than forced into this authed session — asserting
 * them here against a different member would only test RBAC denial, not the golden path.
 * Run with `--workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
// The seeded ISSUED (payable) invoice owned by the e2e-member — reset to status='issued'
// each run by global-setup. The member ALSO has a paid invoice, so picking the first list
// row is unreliable (a paid invoice has no Pay-now CTA); navigate to this one directly.
const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;
const F5 = process.env.FEATURE_F5_ONLINE_PAYMENT === 'true';
const F9 = process.env.FEATURE_F9_DASHBOARD === 'true';

test.describe('Journey — member self-service golden path across module seams @journey', () => {
  // A journey visits ~6 portal routes; under `next dev` each route compiles on first hit
  // (Turbopack), so the default 30 s per-test budget is too tight on a cold run. 120 s is
  // ample here and on the pre-built preview (where routes are already compiled).
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    if (!MEMBER_EMAIL) {
      throw new Error(
        'E2E_MEMBER_EMAIL/E2E_MEMBER_PASSWORD missing — set the seeded member creds in .env.local before running @journey.',
      );
    }
  });

  test('member walks sign-in → invoices → pay → profile → benefits → GDPR export', async ({
    page,
  }, testInfo) => {
    const skipped: string[] = [
      'renewal reminder + broadcast unsubscribe (token-gated public flows — covered by portal-renewal & broadcast-unsubscribe specs)',
    ];
    const gated = async (name: string, enabled: boolean, fn: () => Promise<void>): Promise<void> => {
      if (!enabled) {
        skipped.push(name);
        return;
      }
      await fn();
    };

    // --- F1 — sign in to the member portal (lands on /portal) ---
    await signInAsMember(page);
    await expect(
      page.getByText(/recent invoices|ใบแจ้งหนี้ล่าสุด|senaste fakturor/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // --- F4 — own invoices are listed ---
    await page.goto('/portal/invoices');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });

    // --- F5 — open the seeded ISSUED invoice and reach the Pay-now affordance (only when
    // online payment is live and the issued-invoice fixture is seeded) ---
    await gated('F5 pay-now affordance', F5 && Boolean(ISSUED_INVOICE_ID), async () => {
      await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('pay-now-button')).toBeVisible({ timeout: 10_000 });
    });

    // --- F3 — profile is editable ---
    await page.goto('/portal/profile');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });

    // --- F9 — own plan + tier benefits are viewable ---
    await gated('F9 benefits', F9, async () => {
      await page.goto('/portal/benefits');
      await expect(page.getByRole('heading', { name: 'Benefits', level: 1 })).toBeVisible({
        timeout: 10_000,
      });
    });

    // --- F9 — GDPR data export is requestable ---
    await gated('F9 GDPR export', F9, async () => {
      await page.goto('/portal/account/data-export');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /request my data export/i })).toBeVisible({
        timeout: 10_000,
      });
    });

    testInfo.annotations.push({
      type: 'journey-steps-skipped (feature dark or covered elsewhere)',
      description: skipped.join(' · '),
    });
  });
});
