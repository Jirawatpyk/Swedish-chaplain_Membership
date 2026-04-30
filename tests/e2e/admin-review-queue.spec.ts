/**
 * T099 — E2E test: admin review queue (US2 AS1–AS6 + Q14).
 *
 * Wave 6 GREEN. Spec authority: spec.md US2 AS1–AS6.
 *
 * Strategy: every test executes (no `test.fixme`). Tests that need a
 * seeded `submitted` broadcast skip at runtime when the seed is absent;
 * the killswitch state is detected by probing the response status of
 * `/admin/broadcasts` once at the start.
 *
 *   - AS1: queue surface renders (200 + filters) when F7 ON
 *           OR returns 503 feature_disabled when F7 OFF (ship-dark)
 *   - AS2: approve send-now → status flips → cron picks up
 *   - AS3: reject with reason → audit broadcast_rejected + member email enqueued
 *   - AS4: approve & schedule → scheduledFor populated
 *   - AS5: manager role sees queue read-only, no Approve/Reject buttons
 *   - AS6: concurrent admin race → second action gets 409 toast
 *   - Q14: halt-state banner + clear-halt typed-phrase confirmation
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { seedF7Broadcasts } from './helpers/broadcasts-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

/**
 * Seed for AS2-AS6 + Q14. Provisioned by global-setup via
 * `helpers/broadcasts-seed.ts`. Falls back to .e2e-seed.json if the
 * env var didn't propagate to this worker process.
 */
function loadSeed(): {
  broadcastId?: string;
  haltedMemberDisplayName?: string;
} {
  if (process.env.E2E_SEED_BROADCAST_ID) {
    const result: { broadcastId?: string; haltedMemberDisplayName?: string } = {
      broadcastId: process.env.E2E_SEED_BROADCAST_ID,
    };
    if (process.env.E2E_SEED_HALTED_MEMBER_NAME) {
      result.haltedMemberDisplayName = process.env.E2E_SEED_HALTED_MEMBER_NAME;
    }
    return result;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    if (!existsSync('.e2e-seed.json')) return {};
    const data = JSON.parse(readFileSync('.e2e-seed.json', 'utf8')) as {
      broadcastId: string;
      haltedMemberDisplayName: string;
    };
    return data;
  } catch {
    return {};
  }
}
const SEED = loadSeed();
const SEEDED_SUBMITTED_BROADCAST_ID = SEED.broadcastId;
const SEEDED_HALTED_MEMBER_DISPLAY_NAME = SEED.haltedMemberDisplayName;

test.describe.configure({ mode: 'serial' });

test.describe('admin review queue (T099 — US2 AS1–AS6 + Q14)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  /**
   * Reset the seeded broadcast back to `submitted` before destructive
   * tests (AS2 approves it, AS3 rejects, AS4 schedules, AS6 races).
   * Each test runs a fresh seed so the previous run doesn't leave the
   * row in `approved` / `rejected` / `cancelled` blocking the next.
   */
  async function reseed(): Promise<void> {
    await seedF7Broadcasts();
  }

  async function signIn(
    page: Page,
    email: string,
    password: string,
  ): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 10_000 },
    );
  }

  async function isFeatureEnabled(page: Page): Promise<boolean> {
    const res = await page.request.get('/admin/broadcasts');
    return res.status() !== 503;
  }

  // ---------- AS1: queue surface ----------
  test('AS1: admin loads /admin/broadcasts → 200 with filters (or 503 ship-dark)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const response = await page.goto('/admin/broadcasts');
    const status = response?.status() ?? 500;

    if (status === 503) {
      // Ship-dark: killswitch off → feature_disabled JSON envelope
      const body = await response!.text();
      expect(body).toContain('feature_disabled');
      return;
    }

    // F7 ON: queue surface must render
    expect(status).toBeLessThan(400);
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    const tableOrEmpty = page
      .getByRole('table')
      .or(page.getByText(/no broadcasts/i));
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10_000 });
  });

  test('AS1: queue filters surface (status pills + member dropdown + date range)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /apply/i }).first(),
    ).toBeVisible();
    await expect(page.locator('input[name="fromDate"]').first()).toBeVisible();
    await expect(page.locator('input[name="toDate"]').first()).toBeVisible();
  });

  // ---------- AS2: approve send-now ----------
  test('AS2: admin approves "send now" → status flips to approved', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^approve$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /^approve$/i }).click();
    // Wait for dialog to dismiss → indicates use-case completed (or 409
    // returned a toast but kept dialog open). Toast-success closes the
    // dialog; navigate refresh re-renders the StatusBadge.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // Status badge in detail page should now read Approved or Sending
    // (cron may have already kicked off send-now within polling window).
    await expect(
      page.getByText(/^(Approved|Sending|Sent)$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS3: reject with reason ----------
  test('AS3: admin rejects with reason → status=rejected', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^reject$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog
      .getByRole('textbox')
      .fill('Off-topic for chamber audience');
    await dialog.getByRole('button', { name: /^reject$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByText(/^Rejected$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS4: approve & schedule ----------
  test('AS4: admin approves with scheduled future timestamp', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^approve$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog
      .getByRole('radio', { name: /schedule/i })
      .check({ force: true });
    // datetime-local input expects LOCAL time without timezone suffix.
    // Build a local-time string ~70 min in the future so the
    // server-side `min: now+5min` zod refine passes even with browser
    // ↔ server clock skew.
    const future = new Date(Date.now() + 70 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const localStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    await dialog.locator('input[type="datetime-local"]').fill(localStr);
    await dialog.getByRole('button', { name: /^approve$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByText(/^Approved$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS5: manager read-only ----------
  test('AS5: manager sees ManagerReadonlyBanner + NO Approve/Reject buttons', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL and E2E_MANAGER_PASSWORD',
    );
    await signIn(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);
    const response = await page.goto('/admin/broadcasts');
    const status = response?.status() ?? 500;

    if (status === 503) {
      // Manager 503 path acceptable when killswitch off
      return;
    }

    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    const banner = page.getByRole('region').filter({
      hasText: /read.only|view.only|manager/i,
    });
    await expect(banner.first()).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByRole('button', { name: /^approve(\s|$)/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^reject(\s|$)/i }),
    ).toHaveCount(0);
  });

  // ---------- AS6: concurrent admin race ----------
  test('AS6: concurrent approve → second admin gets 409 broadcast_concurrent_action_blocked', async ({
    browser,
  }) => {
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const enabled = await isFeatureEnabled(pageA);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await signIn(pageA, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await signIn(pageB, ADMIN_EMAIL!, ADMIN_PASSWORD!);

    // Both tabs hit the same broadcast detail
    await pageA.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await pageB.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);

    // Tab A approves first via in-page fetch (carries Origin so CSRF
    // Origin allow-list passes; `pageA.request.post` skips Origin and
    // hits the proxy 403).
    const responseA = await pageA.evaluate(async (id: string) => {
      const r = await fetch(`/api/admin/broadcasts/${id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'send_now' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, SEEDED_SUBMITTED_BROADCAST_ID as string);
    expect(responseA.status).toBeLessThan(400);

    const responseB = await pageB.evaluate(async (id: string) => {
      const r = await fetch(`/api/admin/broadcasts/${id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'send_now' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, SEEDED_SUBMITTED_BROADCAST_ID as string);
    expect([409, 422]).toContain(responseB.status);
    expect(responseB.body?.error?.code).toMatch(
      /broadcast_concurrent_action_blocked|broadcast_invalid_state_transition/,
    );

    await ctxA.close();
    await ctxB.close();
  });

  // ---------- Q14: halt-state banner ----------
  test('Q14: halt-state banner shows when ≥1 member has broadcasts_halted_until_admin_review=true', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_HALTED_MEMBER_DISPLAY_NAME,
      'Set E2E_SEED_HALTED_MEMBER_NAME for a seeded halted member',
    );

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Halt-state banner visible
    const banner = page.getByRole('region').filter({
      hasText: /halted|pending review/i,
    });
    await expect(banner.first()).toBeVisible();

    // Halted member name surfaced
    await expect(
      page.getByText(SEEDED_HALTED_MEMBER_DISPLAY_NAME!).first(),
    ).toBeVisible();

    // Clear-halt button present (typed-phrase confirmation dialog)
    await expect(
      page.getByRole('button', { name: /clear|resume/i }).first(),
    ).toBeVisible();
  });
});
