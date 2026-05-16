/**
 * T103 — F6 Phase 9 / US6 manual relink E2E spec.
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/spec.md:135-146 (US6 AS1/AS2)
 *   - specs/012-eventcreate-integration/spec.md:209-210 (FR-014 incl.
 *     round-2 R4 pseudonymised-row disallow rule)
 *   - specs/012-eventcreate-integration/tasks.md:362-376 (T103-T106)
 *
 * Coverage:
 *   1. AS1 — non_member row → admin opens row's Relink dialog → searches
 *      for a known member → confirms → success toast appears + the row's
 *      match-status badge updates (no full page reload).
 *   2. AS2 — matched & counted member-contact row → admin opens Relink →
 *      picks a different member → success toast. The quota credit-back
 *      math is verified in the live-Neon integration test
 *      (tests/integration/events/relink-registration.test.ts); E2E
 *      asserts the UI outcome only (toast + match badge update).
 *   3. FR-014 round-2 R4 — pseudonymised row (pii_pseudonymised_at !=
 *      NULL) renders the inline "Cannot relink — attendee PII has been
 *      retention-purged…" message in place of the CTA; no Relink button
 *      is present for that registration.
 *
 * RED reason at first run: the use-case (T104), route (T105), and dialog
 * (T106) do not yet exist; clicking Relink either does nothing or 404s.
 * Test moves to GREEN as those files land.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + E2E_MEMBER_EMAIL.
 * The non_member relink target uses E2E_MEMBER_EMAIL so the spec runs
 * deterministically against a known company name.
 *
 * Run with: pnpm test:e2e tests/e2e/relink-attendee.spec.ts --workers=1
 * (per CLAUDE.md memory feedback_e2e_workers — workers>1 hangs locally.)
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  seedF6RelinkFixture,
  type SeedRelinkFixtureResult,
} from './helpers/eventcreate-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;

test.describe.configure({ timeout: 120_000 });

test.describe('@a11y @e2e F6 US6 manual relink', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD || !MEMBER_EMAIL,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD + E2E_MEMBER_EMAIL to run F6 relink E2E',
  );

  let fixture: SeedRelinkFixtureResult | null = null;

  test.beforeAll(async () => {
    fixture = await seedF6RelinkFixture();
    if (!fixture) {
      throw new Error(
        'seedF6RelinkFixture returned null — DATABASE_URL is required for this spec',
      );
    }
    if (!fixture.e2eMemberId) {
      // Defensive: env check above guarantees E2E_MEMBER_EMAIL is set,
      // but if the member row was wiped from the tenant we cannot
      // exercise the picker — skip the whole describe.
      test.skip(true, 'e2e-member not resolved in fixture; AS1/AS2 cannot run');
    }
  });

  test('AS1 — admin relinks a non_member row to the e2e-member via picker (no page reload)', async ({
    page,
  }) => {
    if (!fixture || !fixture.e2eMemberCompany) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsAdmin(page);
    const detailUrl = `/admin/events/${fixture.eventId}`;
    await page.goto(detailUrl);
    await page.waitForLoadState('networkidle');

    // Round-1 test-M8 — stronger no-reload assertion: capture URL +
    // attach a navigation listener BEFORE the relink action. AS1
    // explicitly states "shows the new match status without a page
    // reload"; `networkidle` after the click is too weak (fires for
    // router.refresh() too).
    let navigated = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigated = true;
    });
    const urlBefore = page.url();

    // Locate the Relink button on the non_member row. The dialog mounts
    // a per-row trigger with `data-testid="relink-button-{registrationId}"`.
    const trigger = page.getByTestId(
      `relink-button-${fixture.nonMemberRegistrationId}`,
    );
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Dialog opens with a cmdk picker. Type a substring of the e2e
    // member's company name; the picker fetches /api/admin/members/search.
    const picker = page.getByRole('combobox', { name: /search/i });
    await expect(picker).toBeVisible();
    const companySubstring = fixture.e2eMemberCompany.slice(0, 4);
    await picker.fill(companySubstring);

    // Wait for the picker to surface at least one item, then click the
    // first match. Items render as cmdk `CommandItem`s with role=option.
    const firstOption = page.getByRole('option').first();
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    await firstOption.click();

    // Sonner toast surfaces with the success status role=status. The
    // dialog auto-closes on success.
    await expect(
      page.getByRole('status').filter({ hasText: /relinked/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The row's match-status badge updates from "Non-member" to
    // "Verified contact" (matchType=member_contact). The badge text
    // comes from admin.events.matchType.member_contact ("Verified
    // contact" in EN).
    await page.waitForLoadState('networkidle');
    const updatedRow = page
      .getByTestId(`relink-button-${fixture.nonMemberRegistrationId}`)
      .locator('xpath=ancestor::tr');
    await expect(updatedRow).toContainText(/verified contact/i);

    // Round-1 test-M8 — no full navigation fired AND URL unchanged
    // (router.refresh() is fine, page.goto/push is not).
    expect(navigated).toBe(false);
    expect(page.url()).toBe(urlBefore);
  });

  test('AS2 — admin relinks counted A → relink-target B with success toast (not noop)', async ({
    page,
  }) => {
    if (!fixture || !fixture.e2eMemberCompany) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsAdmin(page);
    await page.goto(`/admin/events/${fixture.eventId}`);
    await page.waitForLoadState('networkidle');

    const trigger = page.getByTestId(
      `relink-button-${fixture.countedRegistrationId}`,
    );
    await expect(trigger).toBeVisible();
    await trigger.click();

    const picker = page.getByRole('combobox', { name: /search/i });
    await expect(picker).toBeVisible();
    // Round-1 test-M6 + Round-2 test-K closure — search for the
    // distinct "Relink Target E2E Co" member (NOT the e2e-member,
    // which would be the noop short-circuit). Spec AS2 explicitly
    // requires the A→B credit-back path (spec.md:146), not A→A.
    //
    // Round-2 test-K — use a discriminative 13-char substring
    // ("Relink Target") instead of 6 ("Relink") so the picker
    // returns ONLY the target member, never an unrelated company
    // that happens to start with "Relink".
    await picker.fill(fixture.relinkTargetCompany.slice(0, 13));
    const firstOption = page.getByRole('option').first();
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    // Verify the option text matches the target company before
    // clicking — defence-in-depth against picker surfacing the
    // wrong row.
    await expect(firstOption).toContainText(/Relink Target/i);
    await firstOption.click();

    // Success toast (not noop) because A ≠ B. The integration test
    // owns the credit-back arithmetic; here we only assert the UI
    // wire-up + the absence of the noop short-circuit.
    await expect(
      page.getByRole('status').filter({ hasText: /relinked/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('FR-014 round-2 R4 — pseudonymised row renders inline disallowed message instead of Relink CTA', async ({
    page,
  }) => {
    if (!fixture) {
      test.skip(true, 'fixture not seeded');
      return;
    }
    await signInAsAdmin(page);
    await page.goto(`/admin/events/${fixture.eventId}`);
    await page.waitForLoadState('networkidle');

    // The disallowed message renders inline on the pseudonymised row
    // with `data-testid="relink-disallowed-{registrationId}"`.
    const disallowed = page.getByTestId(
      `relink-disallowed-${fixture.pseudonymisedRegistrationId}`,
    );
    await expect(disallowed).toBeVisible();
    // i18n-localised FR-014 message — EN default substring.
    await expect(disallowed).toContainText(/retention-purged/i);

    // And the Relink CTA must be ABSENT for this row.
    const trigger = page.getByTestId(
      `relink-button-${fixture.pseudonymisedRegistrationId}`,
    );
    await expect(trigger).toHaveCount(0);
  });
});
