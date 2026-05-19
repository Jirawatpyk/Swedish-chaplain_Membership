/**
 * T100 — E2E: F6 webhook secret rotation with 24h grace period (US7).
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/spec.md User Story 7
 *     AS1 + AS2 + AS3 (lines 150-163)
 *   - specs/012-eventcreate-integration/tasks.md T100 (Phase 8, line 351)
 *   - FR-008 (24h grace window during which old secret continues to verify)
 *   - research.md R7 (24h grace key implementation rationale)
 *
 * Coverage matrix:
 *   - AS1 — admin clicks "Rotate secret" → confirms dialog → sees new
 *           secret (one-time reveal) → masked-secret card updated
 *   - AS2 — webhook signed with OLD secret AT 12h post-rotation →
 *           HTTP 200 + `webhook_secret_grace_used` audit emission
 *   - AS3 — webhook signed with OLD secret AT 25h post-rotation →
 *           HTTP 401 (generic, no oracle) + audit reject
 *
 * Time-travel discipline:
 *   AS2 + AS3 cannot literally sleep 25 real hours. Instead, the seed
 *   helper `seedRotatedWebhookState` writes `grace_rotated_at` as
 *   `NOW() - INTERVAL 'N hours'` so the DB clock evaluates the grace
 *   window correctly. The Playwright runner clock is not used for the
 *   grace decision — only the receiver's `NOW()` vs the DB column is.
 *
 * Workers=1 mandatory: per `feedback_e2e_workers.md` project memory,
 * `pnpm test:e2e` defaults to workers=3 which hangs on the dev
 * workstation. Run with: `pnpm test:e2e --grep "F6 secret rotation"
 * --workers=1 --project=chromium`.
 *
 * Auto-skip pattern: matches `tests/e2e/csv-fallback-import.spec.ts` —
 * tests skip cleanly when `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` are
 * absent so a default `pnpm test:e2e` invocation stays green for
 * contributors who haven't set up the seed env vars.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  resetEventcreateState,
  seedKnownWebhookSecret,
  seedRotatedWebhookState,
  queryAuditEvent,
  F6_E2E_FIXTURE_SECRET,
} from './helpers/eventcreate-seed';
import { signWebhookBody, makeWebhookPayload } from '../integration/events/helpers/sign-webhook';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const TENANT_SLUG =
  process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

// A different "active" secret value — used to seed the post-rotation
// state so the receiver tries (and fails) the active key first, then
// falls through to the grace path with `F6_E2E_FIXTURE_SECRET`.
const POST_ROTATION_ACTIVE_SECRET =
  'whsec_F6E2EPostRotationActiveSecretForBangkok42';

test.describe.configure({ timeout: 180_000 });

// ===========================================================================
// AS1 — Full UI rotation flow.
// ===========================================================================

test.describe('F6 secret rotation — AS1 UI flow @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run F6 secret-rotation e2e',
  );

  test.beforeEach(async ({ page }) => {
    await resetEventcreateState(TENANT_SLUG);
    await seedKnownWebhookSecret(TENANT_SLUG, F6_E2E_FIXTURE_SECRET);
    await signInAsAdmin(page);
  });

  test('AS1 — admin rotates secret → post-rotation one-time reveal + saved-checkbox gate + Done closes → masked-card last4 changes + T102 grace banner', async ({
    page,
  }) => {
    await page.goto('/admin/settings/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');

    // Capture pre-rotation last-4 to assert it changes.
    const masked = page.locator('code', { hasText: /^whsec_/ }).first();
    await expect(masked).toBeVisible();
    const preLastFour = (await masked.textContent())?.slice(-4) ?? '';
    expect(preLastFour.length).toBe(4);
    expect(preLastFour).toBe(F6_E2E_FIXTURE_SECRET.slice(-4));

    // Click Rotate → ConfirmationDialog (role="alertdialog") opens
    // showing PRE-rotation copy + 24h grace info.
    await page.getByRole('button', { name: /rotate secret/i }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/24/)).toBeVisible();

    // Click "Rotate now" → backend rotates secret + emits audit. The
    // ConfirmationDialog is wired with `closeOnConfirm={false}` on the
    // pre-rotation render so the dialog stays open and re-renders into
    // the POST-rotation one-time-reveal view (production fix
    // 2026-05-16 in `confirmation-dialog.tsx` + `rotate-secret-dialog.tsx`).
    await dialog.getByRole('button', { name: /rotate now/i }).click();

    // Post-rotation view: the dialog is STILL visible but now renders
    // the WebhookSecretReveal panel with the new plaintext secret
    // (initially masked) + reveal button + copy button + saved-checkbox
    // + "Done" button (disabled until saved).
    await expect(dialog).toBeVisible();
    const secretValueCode = dialog.locator('[data-testid="webhook-secret-value"]');
    await expect(secretValueCode).toBeVisible({ timeout: 10_000 });

    // The plaintext starts MASKED — body shows bullets + new last4.
    const maskedReveal = (await secretValueCode.textContent()) ?? '';
    expect(maskedReveal).toMatch(/•/);
    // The new last4 is NOT the old last4 (one-time-reveal of fresh secret).
    const newLastFour = maskedReveal.slice(-4);
    expect(newLastFour.length).toBe(4);
    expect(newLastFour).not.toBe(preLastFour);

    // Click the Reveal eye-icon button — plaintext appears.
    // Generated secrets are raw 43-char base64url (32 bytes) — no
    // `whsec_` prefix in storage. The wizard's masked-card prepends
    // the prefix at display time only (see the `<code>` element under
    // the `webhook-secret-label` group in `webhook-config-wizard.tsx`).
    await dialog.getByRole('button', { name: /reveal secret/i }).click();
    const revealed = (await secretValueCode.textContent()) ?? '';
    expect(revealed).not.toMatch(/•/);
    expect(revealed.length).toBeGreaterThanOrEqual(43);
    // Ends with the same last4 we computed from the masked view.
    expect(revealed.slice(-4)).toBe(newLastFour);

    // Done button is disabled until saved-checkbox is ticked (FR-024 gate).
    const doneButton = dialog.getByRole('button', { name: /done/i });
    await expect(doneButton).toBeDisabled();

    // Tick "I've saved this secret in a password manager" checkbox.
    // shadcn/Radix Checkbox renders as `role="checkbox"` (NOT native
    // input), so `.check()` is a no-op. `.click()` triggers the
    // `onCheckedChange` callback that lifts state to the dialog and
    // enables the Done button.
    const savedCheckbox = dialog.getByRole('checkbox', {
      name: /saved.*password manager|saved.*manager/i,
    });
    await savedCheckbox.click();
    await expect(savedCheckbox).toHaveAttribute('aria-checked', 'true');
    await expect(doneButton).toBeEnabled();

    // Click Done — dialog closes via parent state via inline
    // handleOpenChange(false, true).
    await doneButton.click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // After acknowledge, the wizard re-fetches the config view (via
    // `onRotationAcknowledged` → `router.refresh()`) and the masked-card
    // updates to the new last4.
    const maskedAfter = page.locator('code', { hasText: /^whsec_/ }).first();
    await expect(maskedAfter).toBeVisible();
    await expect.poll(
      async () => (await maskedAfter.textContent())?.slice(-4) ?? '',
      { timeout: 5_000 },
    ).not.toBe(preLastFour);
    expect((await maskedAfter.textContent())?.slice(-4)).toBe(newLastFour);

    // T102 — grace banner appears on the wizard surface while the
    // grace window is active. Asserted via stable `data-testid` rather
    // than translated copy so SV/TH wording can change without
    // breaking the test (PR-review L-3, 2026-05-16).
    const banner = page.getByTestId('grace-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });
  });
});

// ===========================================================================
// AS2 + AS3 — Webhook receiver behaviour after rotation.
// Use direct HTTP via Playwright `request` fixture; no browser needed.
// ===========================================================================

test.describe('F6 secret rotation — webhook receiver grace window @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run F6 secret-rotation e2e',
  );

  test('AS2 — 12h post-rotation: OLD secret still verifies → HTTP 200 + grace_used audit', async ({
    request,
    baseURL,
  }) => {
    // Seed: active=POST_ROTATION_ACTIVE, grace=F6_E2E_FIXTURE_SECRET,
    // grace_rotated_at = NOW - 12h.
    await resetEventcreateState(TENANT_SLUG);
    await seedRotatedWebhookState(TENANT_SLUG, {
      oldSecret: F6_E2E_FIXTURE_SECRET,
      newActiveSecret: POST_ROTATION_ACTIVE_SECRET,
      ageHours: 12,
    });

    // Sign payload with the OLD secret — should match grace key.
    const payload = makeWebhookPayload({ tenantSlug: TENANT_SLUG });
    const signed = signWebhookBody({
      body: payload,
      secret: F6_E2E_FIXTURE_SECRET,
    });

    const requestId = randomUUID();
    const response = await request.post(
      `${baseURL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-chamber-signature': signed.signatureHeader,
          'x-chamber-timestamp': signed.timestamp,
          'x-request-id': requestId,
        },
        data: signed.rawBody,
      },
    );

    expect(response.status()).toBe(200);

    // Grace-used audit row must exist (FR-008 audit-trail compliance).
    const auditRow = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_secret_grace_used',
      requestId,
    );
    expect(auditRow).not.toBeNull();
    expect(auditRow?.event_type).toBe('webhook_secret_grace_used');
    // The payload should include `graceSecretAgeHours` ∈ [11, 13]
    // (12h ± 1h tolerance for cross-region clock skew).
    const auditPayload = (auditRow?.payload ?? {}) as {
      graceSecretAgeHours?: number;
      severity?: string;
    };
    expect(auditPayload.severity).toBe('warn');
    expect(auditPayload.graceSecretAgeHours).toBeGreaterThanOrEqual(11);
    expect(auditPayload.graceSecretAgeHours).toBeLessThanOrEqual(13);
  });

  test('AS3 — 25h post-rotation: OLD secret rejected → HTTP 401 (generic)', async ({
    request,
    baseURL,
  }) => {
    // Seed grace_rotated_at = NOW - 25h (window expired).
    await resetEventcreateState(TENANT_SLUG);
    await seedRotatedWebhookState(TENANT_SLUG, {
      oldSecret: F6_E2E_FIXTURE_SECRET,
      newActiveSecret: POST_ROTATION_ACTIVE_SECRET,
      ageHours: 25,
    });

    // Sign with the now-expired OLD secret.
    const payload = makeWebhookPayload({ tenantSlug: TENANT_SLUG });
    const signed = signWebhookBody({
      body: payload,
      secret: F6_E2E_FIXTURE_SECRET,
    });

    const requestId = randomUUID();
    const response = await request.post(
      `${baseURL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-chamber-signature': signed.signatureHeader,
          'x-chamber-timestamp': signed.timestamp,
          'x-request-id': requestId,
        },
        data: signed.rawBody,
      },
    );

    expect(response.status()).toBe(401);

    // Body must be generic — no oracle leak about WHICH path failed
    // (active mismatch vs grace expired vs timestamp skew vs missing
    // header). The receiver's generic body says "Signature or
    // timestamp validation failed" without disclosing the verifier's
    // discriminator kind. So we assert:
    //   - NEGATIVE: body does not mention `grace` or `expired` (those
    //     are the words that would leak the deprecated-grace vs
    //     active-mismatch distinction);
    //   - POSITIVE: body is a non-empty JSON problem-detail envelope
    //     so an empty 401 body doesn't trivially satisfy the .not
    //     checks above.
    const body = await response.text();
    const lower = body.toLowerCase();
    expect(lower).not.toContain('grace');
    expect(lower).not.toContain('expired');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/^\{[\s\S]*"status":\s*401[\s\S]*\}$/);

    // POSITIVE assertion (PR-review CG-1, 2026-05-16): the receiver
    // MUST emit a `webhook_signature_rejected` audit row tied to this
    // requestId. AS3 in spec.md:162 literally requires "records the
    // receipt in the audit log as a signature-failure on the
    // deprecated-grace key" — without this assertion the test only
    // verifies absence of the grace-used row, which a future refactor
    // could trivially satisfy by suppressing both emissions.
    const rejectAudit = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_signature_rejected',
      requestId,
    );
    expect(rejectAudit).not.toBeNull();
    expect(rejectAudit?.event_type).toBe('webhook_signature_rejected');
    const rejectPayload = (rejectAudit?.payload ?? {}) as {
      severity?: string;
      sourceIp?: string;
      signatureLastFour?: string | null;
    };
    expect(rejectPayload.severity).toBe('warn');

    // NEGATIVE: no `webhook_secret_grace_used` row (window closed).
    const graceAudit = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_secret_grace_used',
      requestId,
      500, // short timeout — we EXPECT not-found
    );
    expect(graceAudit).toBeNull();
  });

  test('D2a (Phase 8 verify): 23h59m post-rotation — boundary INCLUSIVE → still verifies → HTTP 200 + grace_used audit', async ({
    request,
    baseURL,
  }) => {
    // Verify-step D2 (2026-05-16) — E2E boundary at 23h59m. Verifier
    // unit/integration tests (`signature.test.ts` S2a) cover this at
    // the pure-crypto layer; this test confirms the full HTTP → DB →
    // audit-emit chain works at the cliff. Seed `grace_rotated_at`
    // at 23h59m ago — the verifier's `graceAgeMs <= 24h * 60 * 60 *
    // 1000` check should pass (still within window).
    //
    // 23.983h = 23h59m (close enough; sub-minute precision is at the
    // DB clock + cross-region RTT noise floor, so we don't chase
    // millisecond-exact boundary).
    await resetEventcreateState(TENANT_SLUG);
    await seedRotatedWebhookState(TENANT_SLUG, {
      oldSecret: F6_E2E_FIXTURE_SECRET,
      newActiveSecret: POST_ROTATION_ACTIVE_SECRET,
      ageHours: 23.983,
    });

    const payload = makeWebhookPayload({ tenantSlug: TENANT_SLUG });
    const signed = signWebhookBody({
      body: payload,
      secret: F6_E2E_FIXTURE_SECRET,
    });

    const requestId = randomUUID();
    const response = await request.post(
      `${baseURL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-chamber-signature': signed.signatureHeader,
          'x-chamber-timestamp': signed.timestamp,
          'x-request-id': requestId,
        },
        data: signed.rawBody,
      },
    );

    expect(response.status()).toBe(200);

    const auditRow = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_secret_grace_used',
      requestId,
    );
    expect(auditRow).not.toBeNull();
    expect(auditRow?.event_type).toBe('webhook_secret_grace_used');
    // graceSecretAgeHours floored to integer hours → 23 (Math.floor of 23.983).
    const auditPayload = (auditRow?.payload ?? {}) as { graceSecretAgeHours?: number };
    expect(auditPayload.graceSecretAgeHours).toBe(23);
  });

  test('D2b (Phase 8 verify): 24h00m + 1s post-rotation — boundary EXCLUSIVE → rejected → HTTP 401 + signature_rejected audit', async ({
    request,
    baseURL,
  }) => {
    // Verify-step D2 (2026-05-16) — E2E boundary just past 24h. The
    // verifier's check is `graceAgeMs <= 24h * 60 * 60 * 1000` so
    // 24h + 1s (24.000278h) lies on the EXCLUSIVE side and must
    // reject. Mirrors verifier S2b at the E2E layer.
    await resetEventcreateState(TENANT_SLUG);
    await seedRotatedWebhookState(TENANT_SLUG, {
      oldSecret: F6_E2E_FIXTURE_SECRET,
      newActiveSecret: POST_ROTATION_ACTIVE_SECRET,
      ageHours: 24.0003, // ~24h + 1s
    });

    const payload = makeWebhookPayload({ tenantSlug: TENANT_SLUG });
    const signed = signWebhookBody({
      body: payload,
      secret: F6_E2E_FIXTURE_SECRET,
    });

    const requestId = randomUUID();
    const response = await request.post(
      `${baseURL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-chamber-signature': signed.signatureHeader,
          'x-chamber-timestamp': signed.timestamp,
          'x-request-id': requestId,
        },
        data: signed.rawBody,
      },
    );

    expect(response.status()).toBe(401);

    // Positive: signature_rejected audit emitted.
    const rejectAudit = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_signature_rejected',
      requestId,
    );
    expect(rejectAudit).not.toBeNull();
    expect(rejectAudit?.event_type).toBe('webhook_signature_rejected');

    // Negative: no grace_used audit (window closed at the boundary).
    const graceAudit = await queryAuditEvent(
      TENANT_SLUG,
      'webhook_secret_grace_used',
      requestId,
      500,
    );
    expect(graceAudit).toBeNull();
  });
});
