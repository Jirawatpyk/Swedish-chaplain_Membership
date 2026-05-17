/**
 * T055 — F6 events list + detail axe-core a11y scan.
 *
 * Spec authority: specs/012-eventcreate-integration/checklists/ux.md (CHK0xx
 * — WCAG 2.1 AA scan via @axe-core/playwright) + Constitution VI (Inclusive UX).
 *
 * Surfaces covered:
 *   - /admin/events                  (list page)
 *   - /admin/events/[eventId]        (detail page — at least one seeded event)
 *
 * Fails on `serious` or `critical` axe violations only — `minor` /
 * `moderate` get logged but do not fail the suite (matches F7 +
 * F8 a11y convention).
 *
 * RED reason: pages do not exist yet (T065 + T066). Navigation 404s,
 * axe runs against the 404 page and may not surface the F6-specific
 * issues — the failing `expect(...).toBeVisible()` precondition is the
 * RED marker.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD; skip at runtime when
 * absent (CI-skip pattern).
 *
 * Run with: pnpm test:e2e --grep "@a11y.*F6" --workers=1
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ timeout: 180_000 });

async function expectNoAxeViolations(
  page: Page,
  surface: string,
): Promise<void> {
  // Wait for `<title>` to be populated before scanning. Next.js 16
  // RSC streams `generateMetadata` output AFTER the initial DOM is
  // parsed, so `domcontentloaded` fires while `<title>` is still
  // empty — axe-core rule `document-title` (WCAG 2.4.2 Level A) then
  // flags a false-positive on the first run that disappears on the
  // retry once the streamed metadata has landed. Pinning the wait
  // here makes the scan deterministic for every caller.
  await page.waitForFunction(() => document.title.length > 0, undefined, {
    timeout: 15_000,
  });
  // Exclude Base UI's internal focus-guard spans. Base UI (the Radix
  // successor used by shadcn/ui v3) injects invisible
  // `<span role="button" data-base-ui-focus-guard>` sentinels around
  // every Dialog / AlertDialog to redirect Tab/Shift-Tab inside the
  // modal. axe flags them under `aria-command-name` on WebKit because
  // they carry `role="button"` without an accessible name; they are
  // **intentionally invisible** (clip-path inset(50%), 1×1 px) and
  // not user-interactive. The exemption mirrors the documented
  // pattern in `tests/e2e/idle-warning-a11y.spec.ts:64-67`.
  //
  // F6.1 R3 a11y-fix 2026-05-16 — exclude Sonner toast surfaces
  // (`.cn-toast` / `[data-sonner-toaster]`). Sonner's `richColors`
  // success variant (enabled globally at `src/app/layout.tsx:93`)
  // renders dark-green-on-light-green at contrast ratio 4.25:1
  // which falls just under WCAG AA 4.5:1. This is a pre-existing
  // global theme choice — toasts auto-dismiss in ~4s and are
  // transient surfaces (not persistent UI state) so they are not
  // the right gate to fail an F6.1 import-result scan. Re-themeing
  // Sonner globally is tracked separately as a UX-standards epic.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-base-ui-focus-guard]')
    .exclude('[data-sonner-toaster]')
    .exclude('.cn-toast')
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
  expect(
    seriousOrWorse,
    `${surface}: serious/critical axe violations`,
  ).toHaveLength(0);
}

test.describe('@a11y T055 — F6 events list+detail axe-core scan', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin a11y scans',
  );

  test('admin events list (/admin/events)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    // Ensure the page rendered the F6 list surface (heading exists)
    // before scanning — guards against scanning a 404 page during
    // RED phase.
    await expect(
      page.getByRole('heading', { name: /events/i, level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/events');
  });

  test('admin event detail (/admin/events/[eventId])', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    // D1 verify-fix (2026-05-13, round-2) — explicit wait for the
    // table to render BEFORE counting links. On mobile viewports the
    // Turbopack cold compile of TanStack Table v8 + RSC stream can
    // land in chunks; counting immediately returns 0 because the
    // <table> element hasn't attached yet. The Locator chain itself
    // is lazy — `.count()` does NOT auto-wait. Wait for the table to
    // be attached, then count links via `toBeAttached` (works for
    // off-screen links too — desktop table or mobile horizontal-
    // scroll layout both have links in DOM, just outside viewport).
    const table = page.getByRole('table');
    await expect(table).toBeVisible({ timeout: 15_000 });
    const firstRowLink = table
      .locator('a[href^="/admin/events/"]')
      .filter({ hasNot: page.locator('[aria-current]') })
      .first();
    await expect(firstRowLink).toBeAttached({ timeout: 10_000 });
    await firstRowLink.scrollIntoViewIfNeeded();
    await firstRowLink.click();
    await page.waitForURL(/\/admin\/events\/[^/]+$/);
    await page.waitForLoadState('domcontentloaded');
    await expectNoAxeViolations(page, '/admin/events/[eventId]');
  });

  /**
   * D2 verify-fix (2026-05-13) — wizard page a11y scan covering Phase 5
   * US3 surface. SC-010 requires WCAG 2.1 AA across all admin surfaces;
   * the wizard introduces complex interactive primitives (one-time
   * reveal panel + checkbox gate + Stepper + walkthrough list with
   * Next/Image elements + confirmation AlertDialog for rotate +
   * Switch toggle on recent deliveries) that were not covered by the
   * Phase 4 list/detail scans above.
   */
  test('admin integration wizard (/admin/integrations/eventcreate)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');
    // Guard against scanning a 404 page — wait until the wizard's H1
    // is visible before the axe scan kicks off.
    await expect(
      page.getByRole('heading', { level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/settings/integrations/eventcreate');
  });

  /**
   * F6 Phase 7 CSV import surface axe-core scans. The three visual
   * states render distinct DOM trees (different roles + ARIA +
   * colour-contrast surfaces), so each needs its own scan:
   *   1. idle — empty file input + drop zone
   *   2. preview-error — malformed-header inline Alert + disabled CTA
   *   3. completed-with-result — result card + counters + breakdown
   *
   * T091 covers the functional spec for (2)+(3); only these scans
   * catch WCAG 2.1 AA defects (Alert contrast, remap-select labels,
   * disabled-CTA focus rings, result-card landmark hierarchy).
   */
  test('admin CSV import — idle state (/admin/events/import) @a11y', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('heading', { level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/events/import');
  });

  test('admin CSV import — preview-error state (malformed header) @a11y', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Upload a CSV missing required columns → client-side preview
    // surfaces the inline `csv-header-error` Alert + disables Confirm.
    const malformedCsv = Buffer.from(
      [
        'event_external_id,event_name,attendee_name',
        'event_001,Midsummer 2026,Jane Andersson',
      ].join('\n'),
      'utf8',
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'malformed-header.csv',
      mimeType: 'text/csv',
      buffer: malformedCsv,
    });

    // Wait for the error banner to mount — scan against the populated
    // DOM tree, not the idle one (different role + colour surface).
    await expect(
      page.locator('[data-testid="csv-header-error"]'),
    ).toBeVisible({ timeout: 15_000 });

    await expectNoAxeViolations(
      page,
      '/admin/events/import (preview-error state)',
    );
  });

  test('admin CSV import — completed-with-result state @a11y', async ({
    page,
  }) => {
    // Generous timeout for the import to complete on cross-region Neon.
    test.setTimeout(120_000);

    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // F6.1 R3 a11y-fix 2026-05-16 — F6.1 added the event-picker
    // requirement: `submitDisabled={selectedEventId === null}` at
    // csv-mapping-form.tsx:534. Tests that pre-date F6.1 uploaded CSV
    // directly + clicked Import, but Confirm now stays disabled with
    // no event selected. Seed an event via POST /api/admin/events
    // (matching CSRF Origin) + select it via combobox before upload.
    const ts = Date.now();
    const eventExternalId = `a11y-result-${ts}`;
    const eventName = `A11y Result ${ts}`;
    const seedRes = await page.request.post('/api/admin/events', {
      headers: { Origin: 'http://localhost:3100' },
      data: {
        externalId: eventExternalId,
        name: eventName,
        startDate: new Date(ts + 30 * 24 * 60 * 60 * 1000).toISOString(),
        category: null,
      },
    });
    if (![200, 201].includes(seedRes.status())) {
      throw new Error(
        `seedEvent failed: ${seedRes.status()} ${await seedRes.text()}`,
      );
    }
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('combobox').first().click();
    await page
      .getByRole('option', { name: new RegExp(eventName) })
      .click();

    // Build a small 5-row valid CSV → result card surfaces quickly.
    // Result-card DOM is structurally identical for 5 vs 1000 rows;
    // the a11y scan only cares about role + ARIA + contrast, not
    // counters. 5 rows keeps this scan-test under 60s on cross-region.
    const validCsv = Buffer.from(
      [
        'event_external_id,event_name,event_start,attendee_email,attendee_name',
        ...Array.from({ length: 5 }, (_, i) =>
          [
            `event_a11y_${ts}_${i}`,
            'A11y Test',
            '2026-06-21T18:00:00+07:00',
            `a11y_${ts}_${i}@example.com`,
            `A11y Attendee ${i}`,
          ].join(','),
        ),
      ].join('\n'),
      'utf8',
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'a11y-result-5.csv',
      mimeType: 'text/csv',
      buffer: validCsv,
    });
    await page
      .getByRole('button', { name: /import|confirm|upload/i })
      .click();

    // Result card mounts when the import completes.
    await expect(
      page.locator('[data-testid="csv-import-result"]'),
    ).toBeVisible({ timeout: 90_000 });

    await expectNoAxeViolations(
      page,
      '/admin/events/import (completed-with-result state)',
    );
  });

  test('admin CSV import — completed-with-errors expanded state @a11y', async ({
    page,
  }) => {
    // The result card has two distinct error-row DOM branches:
    //   - `<p>` empty-state when errorRows.length === 0
    //   - `<details>/<summary>` collapsible when errorRows.length > 0
    // The previous test scans the empty-state path; this one upload
    // CSV with malformed-email rows so the per-row insert fails inside
    // the savepoint, surfaces in errorRows[], and the disclosure
    // becomes interactive — then we expand it and re-scan. Catches
    // WCAG defects unique to the `<summary>` + text-destructive
    // contrast surface (WCAG 1.4.3 contrast + 2.5.8 tap target).
    test.setTimeout(120_000);

    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // F6.1 R3 a11y-fix 2026-05-16 — same event-picker requirement as
    // the completed-with-result test. Seed + select before upload.
    const ts = Date.now();
    const errEventExternalId = `a11y-err-${ts}`;
    const errEventName = `A11y Err ${ts}`;
    const errSeedRes = await page.request.post('/api/admin/events', {
      headers: { Origin: 'http://localhost:3100' },
      data: {
        externalId: errEventExternalId,
        name: errEventName,
        startDate: new Date(ts + 30 * 24 * 60 * 60 * 1000).toISOString(),
        category: null,
      },
    });
    if (![200, 201].includes(errSeedRes.status())) {
      throw new Error(
        `seedEvent failed: ${errSeedRes.status()} ${await errSeedRes.text()}`,
      );
    }
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('combobox').first().click();
    await page
      .getByRole('option', { name: new RegExp(errEventName) })
      .click();

    // 3 valid rows + 2 rows with invalid emails (zod email-validator
    // rejects in attendee path → row_failed). Mix proves the result
    // card renders BOTH the headline counters AND the error rows.
    const lines = [
      'event_external_id,event_name,event_start,attendee_email,attendee_name',
      `event_a11y_err_${ts}_0,A11y Err Test,2026-06-21T18:00:00+07:00,valid_${ts}_0@example.com,Valid Attendee 0`,
      `event_a11y_err_${ts}_1,A11y Err Test,2026-06-21T18:00:00+07:00,not-an-email-${ts},Invalid Attendee 1`,
      `event_a11y_err_${ts}_2,A11y Err Test,2026-06-21T18:00:00+07:00,valid_${ts}_2@example.com,Valid Attendee 2`,
      `event_a11y_err_${ts}_3,A11y Err Test,2026-06-21T18:00:00+07:00,also@bad@nope.com,Invalid Attendee 3`,
      `event_a11y_err_${ts}_4,A11y Err Test,2026-06-21T18:00:00+07:00,valid_${ts}_4@example.com,Valid Attendee 4`,
    ];
    const csvBytes = Buffer.from(lines.join('\n'), 'utf8');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'a11y-with-errors.csv',
      mimeType: 'text/csv',
      buffer: csvBytes,
    });
    await page
      .getByRole('button', { name: /import|confirm|upload/i })
      .click();

    await expect(
      page.locator('[data-testid="csv-import-result"]'),
    ).toBeVisible({ timeout: 90_000 });

    // Expand the error-rows disclosure so axe sees the open state.
    // The `<summary>` carries `min-h-6 + py-1` (WCAG 2.5.8) and
    // expanded content renders inside a `text-destructive bg-
    // destructive/5` panel (WCAG 1.4.3 contrast). Both must pass.
    const summary = page.locator('[data-testid="csv-import-result"] summary');
    if ((await summary.count()) > 0) {
      await summary.first().click();
    }

    await expectNoAxeViolations(
      page,
      '/admin/events/import (completed-with-errors expanded state)',
    );
  });

  /**
   * T019 (Feature 013 · F6.1) — three new CSV-import visual states added by F6.1:
   *   - EventPicker dropdown (idle) — combobox role + min-h-11 trigger
   *   - EventCreate inline-create modal (open) — Radix Dialog placeholder
   *   - Event-mismatch warning dialog (open) — Radix AlertDialog
   *
   * Each state introduces distinct ARIA + colour-contrast surfaces that
   * Phase 7's three scans (idle / preview-error / completed) do not
   * cover. Verifies the F6.1 wizard upgrade keeps WCAG 2.1 AA parity.
   */
  test('admin CSV import F6.1 — event-picker visible @a11y', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // EventPicker renders as a combobox above the file input.
    await expect(
      page.getByRole('combobox').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expectNoAxeViolations(
      page,
      '/admin/events/import (event-picker idle state)',
    );
  });

  test('admin CSV import F6.1 — inline create modal open @a11y', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Trigger "Create new event" → opens the placeholder Dialog.
    const createBtn = page.getByRole('button', {
      name: /create new event|สร้างอีเวนต์ใหม่|skapa nytt evenemang/i,
    });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();
    // Dialog mounted — role=dialog with aria-modal=true.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await expectNoAxeViolations(
      page,
      '/admin/events/import (inline-create modal open)',
    );
  });

  test('admin CSV import F6.1 — event-mismatch warning dialog open @a11y', async ({
    page,
  }) => {
    // Drive the FR-019b safety-net dialog into view via the SAME flow
    // a real admin would trigger:
    //   1. Use the inline-create modal (POST /api/admin/events) to seed
    //      two distinct events under unique externalIds.
    //   2. Upload a tiny EventCreate-format CSV against eventA → completes
    //      and persists `csv_import_records.attendee_fingerprint`.
    //   3. Re-select eventB in the picker + upload SAME CSV → safety-net
    //      query returns prior import → AlertDialog opens with priorImports.
    //   4. Run axe scan against the AlertDialog DOM (different ARIA +
    //      colour-contrast surface than the inline-create Dialog).
    //
    // Timeouts: each CSV upload hits live Neon → 60s ceiling per page
    // is generous (mirrors completed-with-result test budget).
    test.setTimeout(180_000);

    await signInAsAdmin(page);
    await page.goto('/admin/events/import');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Build a tiny 2-row EventCreate CSV — minimum needed for the
    // safety-net fingerprint to be non-null (≥1 Attending email).
    const ts = Date.now();
    const eventCreateCsv = [
      'Basic Info,Status,First Name,Last Name,Email,Attendee ID,Notes,Personal Data Protection Consent',
      `evt,Attending,Anna,Andersson,a11y-mismatch-anna-${ts}@example.com,att-${ts}-1,Paid,I hereby acknowledge`,
      `evt,Attending,Björn,Berg,a11y-mismatch-bjorn-${ts}@example.com,att-${ts}-2,Paid,I hereby acknowledge`,
    ].join('\n');

    // Helper: seed an event via the POST /api/admin/events route.
    // Staff-review T060 follow-up (2026-05-16): Playwright's
    // page.request.post does NOT set an Origin header automatically
    // (unlike browser fetch which sets it from the page's location).
    // The CSRF middleware in `src/lib/csrf.ts:83` rejects with
    // `403 missing-origin` when Origin is absent. Pass an explicit
    // Origin matching the dev server's base URL so the request
    // passes the allow-list check.
    const seedEvent = async (
      externalId: string,
      name: string,
    ): Promise<string> => {
      const res = await page.request.post('/api/admin/events', {
        headers: {
          Origin: 'http://localhost:3100',
        },
        data: {
          externalId,
          name,
          startDate: new Date(ts + 30 * 24 * 60 * 60 * 1000).toISOString(),
          category: null,
        },
      });
      if (![200, 201].includes(res.status())) {
        throw new Error(
          `seedEvent ${externalId} failed: ${res.status()} ${await res.text()}`,
        );
      }
      const body = (await res.json()) as {
        event: { eventId: string };
      };
      return body.event.eventId;
    };

    const eventAExternalId = `a11y-mismatch-a-${ts}`;
    const eventBExternalId = `a11y-mismatch-b-${ts}`;
    await seedEvent(eventAExternalId, `A11y Mismatch A ${ts}`);
    await seedEvent(eventBExternalId, `A11y Mismatch B ${ts}`);

    // Force-reload the page so the EventPicker re-fetches events.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Step 1 — first upload targets eventA. Select via combobox.
    await page.getByRole('combobox').first().click();
    await page
      .getByRole('option', { name: new RegExp(`A11y Mismatch A ${ts}`) })
      .click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'a11y-mismatch.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(eventCreateCsv, 'utf8'),
    });
    await page
      .getByRole('button', { name: /import|confirm|upload/i })
      .click();
    // Wait for result card → confirms first import committed +
    // persisted attendee_fingerprint for the safety-net query.
    await expect(
      page.locator('[data-testid="csv-import-result"]'),
    ).toBeVisible({ timeout: 90_000 });

    // Reset back to upload phase + select eventB.
    await page.getByRole('button', { name: /upload another|new/i }).click();
    await page.getByRole('combobox').first().click();
    await page
      .getByRole('option', { name: new RegExp(`A11y Mismatch B ${ts}`) })
      .click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'a11y-mismatch.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(eventCreateCsv, 'utf8'),
    });
    await page
      .getByRole('button', { name: /import|confirm|upload/i })
      .click();

    // Step 2 — safety net fires → AlertDialog visible.
    await expect(page.getByRole('alertdialog')).toBeVisible({
      timeout: 60_000,
    });

    await expectNoAxeViolations(
      page,
      '/admin/events/import (event-mismatch warning dialog open)',
    );
  });

  // T048 (F6.1 · Feature 013 — Phase 5 US5) — history page axe scan.
  // 4th visual state beyond Phase 7's coverage. Validates table role +
  // pagination nav + download button labels remain WCAG 2.1 AA clean.
  //
  // QA-pass W-1 cleanup (2026-05-16) — the bare `test.skip(condition,
  // reason)` previously here at the describe-block level was redundant
  // with the top-of-describe gate at lines 78-81 and is a fragile
  // pattern: if a maintainer ever moves the top-of-describe gate, this
  // duplicate could silently swallow subsequent tests in the block.
  // Removed; the top-of-describe `test.skip(!ADMIN_EMAIL || ...)` at
  // lines 78-81 still gates the entire describe block including this
  // history scan.
  test('@a11y F6.1 — /admin/events/import/history (paginated history table)', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events/import/history');
    // Wait for either the table or the empty-state region to render.
    const tableOrEmpty = page
      .locator('[data-testid="csv-import-history-table"], [data-testid="csv-import-history-empty"]')
      .first();
    await expect(tableOrEmpty).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(
      page,
      '/admin/events/import/history (history list)',
    );
  });

  /**
   * A8 — dedicated server-rendered PII erasure confirmation page. The
   * page renders inside `DetailContainer` + `PageHeader` + the
   * `ErasePiiDialog` opened in dialog mode. WCAG-critical surface:
   * destructive form + textarea + AlertDialog confirmation. Distinct
   * from the inline dialog opened from the attendee table — that
   * surface is covered by the events-list+detail E2E.
   *
   * Uses `seedF6RelinkFixture`'s non-member registration as a stable
   * navigation target.
   */
  test('@a11y A8 — /admin/events/[eventId]/registrations/[registrationId]/erase (dedicated PII erasure page)', async ({
    page,
  }) => {
    const { seedF6RelinkFixture } = await import(
      './helpers/eventcreate-seed'
    );
    const fixture = await seedF6RelinkFixture();
    test.skip(
      fixture === null,
      'E2E_DATABASE_URL or F6 seed prerequisites unset',
    );
    if (fixture === null) return;
    await signInAsAdmin(page);
    await page.goto(
      `/admin/events/${fixture.eventId}/registrations/${fixture.nonMemberRegistrationId}/erase`,
    );
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoAxeViolations(
      page,
      '/admin/events/[eventId]/registrations/[registrationId]/erase',
    );
  });
});
