/**
 * Golden-path JOURNEY E2E — MANAGER persona (read-only finance) (docs/go-live-readiness.md § 4 Stage 1b + § 7).
 *
 * Walks the manager journey end-to-end across module seams:
 *   sign-in (F1) → view members (F3) → view invoices read-only (F4) → dashboard + audit (F9)
 *   → escalation queue read-only (F8).
 *
 * The DEFINING assertions are the read-only NEGATIVES: a manager must be able to VIEW finance
 * surfaces but must NOT see mutate affordances (no "New invoice", no record-payment / refund /
 * void triggers, no renewal-task action buttons). These guard against an RBAC regression that
 * silently grants a read-only role write affordances — invisible to a happy-path admin spec.
 * Run with `--workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsManager } from './helpers/manager-session';

const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;
const F8 = process.env.FEATURE_F8_RENEWALS === 'true';
const F9 = process.env.FEATURE_F9_DASHBOARD === 'true';

test.describe('Journey — manager read-only golden path across module seams @journey', () => {
  // A journey visits several admin routes; under `next dev` each compiles on first hit,
  // blowing the default 30 s budget on a cold run. 120 s is ample here and on the preview.
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    if (!MANAGER_EMAIL) {
      throw new Error(
        'E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD missing — set the seeded manager creds in .env.local before running @journey.',
      );
    }
  });

  test('manager walks sign-in → members → invoices (read-only) → dashboard → audit → escalation', async ({
    page,
  }, testInfo) => {
    const skipped: string[] = [];
    const gated = async (name: string, enabled: boolean, fn: () => Promise<void>): Promise<void> => {
      if (!enabled) {
        skipped.push(name);
        return;
      }
      await fn();
    };

    // --- F1 — sign in as manager (same /admin/sign-in URL; RBAC differentiates) ---
    await signInAsManager(page);

    // --- F3 — members are viewable ---
    await page.goto('/admin/members');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // --- F4 — invoices viewable, but NO "New invoice" affordance (read-only finance) ---
    await page.goto('/admin/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /new invoice/i })).toHaveCount(0);

    // --- F4 — invoice detail shows NO mutate triggers for a manager ---
    if (ISSUED_INVOICE_ID) {
      await page.goto(`/admin/invoices/${ISSUED_INVOICE_ID}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('record-payment-trigger')).toHaveCount(0);
      await expect(page.getByTestId('refund-dialog-trigger')).toHaveCount(0);
      await expect(page.getByTestId('void-invoice-trigger')).toHaveCount(0);
    } else {
      skipped.push('F4 invoice-detail read-only (no E2E_ISSUED_INVOICE_ID seed)');
    }

    // --- F9 — dashboard + audit are viewable by a manager ---
    await gated('F9 dashboard', F9, async () => {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
        timeout: 10_000,
      });
    });
    await gated('F9 audit log', F9, async () => {
      await page.goto('/admin/audit');
      await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible({
        timeout: 10_000,
      });
    });

    // --- F8 — escalation queue is viewable but read-only (no action buttons; read-only note) ---
    await gated('F8 escalation queue (read-only)', F8, async () => {
      await page.goto('/admin/renewals/tasks');
      await expect(page.getByRole('heading', { name: /escalation tasks/i })).toBeVisible({
        timeout: 10_000,
      });
      // Read-only banner present; no Done/Skip/Reassign action buttons rendered for a manager.
      await expect(page.getByRole('button', { name: /^(done|skip|reassign)$/i })).toHaveCount(0);
    });

    if (skipped.length > 0) {
      testInfo.annotations.push({
        type: 'journey-steps-skipped (feature dark)',
        description: skipped.join(' · '),
      });
    }
  });
});
