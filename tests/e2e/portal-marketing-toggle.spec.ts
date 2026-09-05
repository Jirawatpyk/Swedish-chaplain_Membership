/**
 * 108 PR-D T062 — E2E: a contact manages their own marketing preference in
 * the portal (US6).
 *
 * @a11y
 *
 *   1. the signed-in member sees their marketing state on /portal/profile and
 *      switches it off → the state reads "off (by contact)"; switches it back
 *      on;
 *   2. when the person's own unsubscribe is in force, the profile shows
 *      "unsubscribed" and NO control (seeded suppression row, removed after);
 *   3. axe-core on the profile page with the toggle rendered.
 *
 * The staff-side view of the same change ("off (by contact)" on the member
 * page) is covered by admin-marketing-audience.spec.ts; the money-email
 * invariant behind the primary's note (FR-033) is proved on live Neon in
 * tests/integration/members/contact-marketing-opt-out.test.ts.
 *
 * Env vars: E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD (scripts/seed-e2e-user.ts).
 * Run with `--workers=1`.
 */
import AxeBuilder from '@axe-core/playwright';
import en from '@/i18n/messages/en.json';
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { openSeedClient } from './helpers/open-seed-client';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;
const t = en.portal.profile.marketing;

async function setSuppressed(email: string, suppressed: boolean): Promise<void> {
  const client = openSeedClient('e2e portal marketing toggle');
  if (!client) throw new Error('DATABASE_URL missing — cannot seed the suppression row');
  try {
    const emailLower = email.toLowerCase();
    if (suppressed) {
      await client.sql`
        INSERT INTO marketing_unsubscribes (tenant_id, email_lower, member_id, reason)
        VALUES (${TENANT_ID}, ${emailLower}, NULL, 'recipient_initiated')
        ON CONFLICT (tenant_id, email_lower) DO NOTHING
      `;
    } else {
      await client.sql`
        DELETE FROM marketing_unsubscribes WHERE tenant_id = ${TENANT_ID} AND email_lower = ${emailLower}
      `;
    }
  } finally {
    await client.end();
  }
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('108 PR-D — portal self marketing toggle (US6) @a11y', () => {
  test.skip(!MEMBER_EMAIL, 'Set E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD (seeded by scripts/seed-e2e-user.ts)');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    // Make sure no earlier run left the persona suppressed.
    await setSuppressed(MEMBER_EMAIL!, false);
  });

  test('1. switch off → "off (by contact)"; switch on → "on"', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/profile', { waitUntil: 'domcontentloaded' });
    const region = page.getByTestId('portal-marketing');
    await expect(region).toBeVisible();

    const sw = region.getByRole('switch', { name: t.switchLabel });
    const initiallyOn = (await sw.getAttribute('aria-checked')) === 'true';
    if (!initiallyOn) {
      // A previous run left it off — switch on first so the walk is deterministic.
      await sw.click();
      await expect(region).toHaveAttribute('data-marketing-state', 'on', { timeout: 15_000 });
    }

    await region.getByRole('switch').click();
    await expect(region).toHaveAttribute('data-marketing-state', 'off_by_contact', { timeout: 15_000 });
    await expect(region.getByText(t.state.off_by_contact)).toBeVisible();

    await region.getByRole('switch').click();
    await expect(region).toHaveAttribute('data-marketing-state', 'on', { timeout: 15_000 });
    await expect(region.getByText(t.state.on)).toBeVisible();
  });

  test('2. unsubscribed → text only, no control', async ({ page }) => {
    await setSuppressed(MEMBER_EMAIL!, true);
    try {
      await signInAsMember(page);
      await page.goto('/portal/profile', { waitUntil: 'domcontentloaded' });
      const region = page.getByTestId('portal-marketing');
      await expect(region).toHaveAttribute('data-marketing-state', 'unsubscribed');
      await expect(region.getByText(t.state.unsubscribed)).toBeVisible();
      await expect(region.getByRole('switch')).toHaveCount(0);
    } finally {
      await setSuppressed(MEMBER_EMAIL!, false);
    }
  });

  test('3. no axe violations on the profile page with the toggle @a11y', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/profile', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('portal-marketing')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(results.violations).toEqual([]);
  });
});
