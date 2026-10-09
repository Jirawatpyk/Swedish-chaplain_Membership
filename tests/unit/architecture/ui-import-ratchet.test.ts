/**
 * Spec 122 FR-008 — the AURA migration's import ratchet
 * (contracts/lint-ratchet.md, `eslint.ui-ratchet.mjs`).
 *
 * Each ban is proven to FIRE through the real `eslint.config.mjs`, not by
 * reading the config text: a lint rule that is shadowed by a later flat-config
 * block is silent, and silence reads like approval (see auth-barrel.test.ts).
 * The migrated-paths ban is exercised with a fixture glob appended through
 * `overrideConfig` (`MIGRATED_PATHS` must not carry a test-only entry), and
 * through the real list for the US1 shell.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { uiRatchet } from '../../../eslint.ui-ratchet.mjs';

const RULE = '@typescript-eslint/no-restricted-imports';
const FIXTURE_GLOB = 'src/__ratchet_fixture__/**';

async function ratchetHits(
  code: string,
  filePath: string,
  migratedPaths: readonly string[] = [],
): Promise<string[]> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    ...(migratedPaths.length > 0 ? { overrideConfig: uiRatchet(migratedPaths) } : {}),
  });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe('UI import ratchet (spec 122)', () => {
  it('bans sonner everywhere, in source and in tests', async () => {
    const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
    expect(await ratchetHits(code, 'src/components/some-form.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'tests/unit/some-form.test.tsx')).toHaveLength(1);
  });

  it.each(['formatDate', 'useFormatDate'])('bans AURA %s (our formatter is canonical)', async (name) => {
    const code = `import { ${name} } from '@jirawatpyk/aura-react';\nexport const f = ${name};\n`;
    const hits = await ratchetHits(code, 'src/components/some-view.tsx');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('format-date-localised');
  });

  it('allows the rest of @jirawatpyk/aura-react', async () => {
    const code = "import { Button } from '@jirawatpyk/aura-react';\nexport const B = Button;\n";
    expect(await ratchetHits(code, 'src/components/some-view.tsx')).toEqual([]);
  });

  it('bans cmdk everywhere except the legacy kit host (kept for the pickers until their modules migrate)', async () => {
    const code = "import { Command } from 'cmdk';\nexport const C = Command;\n";
    expect(await ratchetHits(code, 'src/components/shell/palette.tsx')).toHaveLength(1);
    expect(await ratchetHits(code, 'src/components/ui/command.tsx')).toEqual([]);
  });

  it('keeps the global bans on the cmdk host', async () => {
    const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
    expect(await ratchetHits(code, 'src/components/ui/command.tsx')).toHaveLength(1);
  });

  describe('migrated paths', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";
    const file = 'src/__ratchet_fixture__/page.tsx';

    it('a path on AURA cannot import the legacy kit', async () => {
      const hits = await ratchetHits(legacy, file, [FIXTURE_GLOB]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('MIGRATED_PATHS');
    });

    it('control: the same import outside the list passes', async () => {
      expect(await ratchetHits(legacy, file)).toEqual([]);
    });

    it('the migrated block restates the global bans (flat config replaces, never merges)', async () => {
      const code = "import { toast } from 'sonner';\nexport const t = toast;\n";
      expect(await ratchetHits(code, file, [FIXTURE_GLOB])).toHaveLength(1);
    });

    it('a file named as not-yet-migrated keeps the legacy kit until its phase', async () => {
      const eslint = new ESLint({ cwd: process.cwd(), overrideConfig: uiRatchet([FIXTURE_GLOB], [file]) });
      const [result] = await eslint.lintText(legacy, { filePath: file });
      expect((result?.messages ?? []).filter((m) => m.ruleId === RULE)).toEqual([]);
    });
  });

  describe('the US1 shell is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/components/layout/staff-shell.tsx',
      'src/components/shell/user-menu.tsx',
      'src/components/command-palette/command-palette.tsx',
      'src/components/auth/idle-warning-dialog.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('except the reason dialog, which moves with the E-Blast review (US12)', async () => {
      expect(await ratchetHits(legacy, 'src/components/shell/reason-confirmation-dialog.tsx')).toEqual([]);
    });
  });

  describe('the US2 auth pages are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(auth-public)/admin/sign-in/page.tsx',
      'src/app/(auth-public)/reset-password/[token]/page.tsx',
      'src/components/auth/sign-in-form.tsx',
      'src/components/auth/change-password-form.tsx',
      'src/components/auth/change-password-form-skeleton.tsx',
      'src/components/auth/password-strength.tsx',
      'src/components/auth/security-update-banner.tsx',
      'src/components/auth/auth-frame.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the user-admin screens in the same folder keep the legacy kit until US10', async () => {
      expect(await ratchetHits(legacy, 'src/components/auth/user-list-table.tsx')).toEqual([]);
    });
  });

  describe('the US3 member portal is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(member)/portal/(home)/page.tsx',
      'src/app/(member)/portal/_components/recent-activity-section.tsx',
      'src/app/(member)/portal/profile/page.tsx',
      'src/app/(member)/portal/profile/directory/page.tsx',
      'src/app/(member)/portal/edit/page.tsx',
      'src/app/(member)/portal/change-requests/page.tsx',
      'src/app/(member)/portal/account/page.tsx',
      'src/app/(member)/portal/contacts/invite/page.tsx',
      'src/app/(member)/portal/timeline/page.tsx',
      'src/app/(member)/portal/benefits/page.tsx',
      'src/app/(member)/portal/not-found.tsx',
      'src/app/(member)/portal/[...unknown]/page.tsx',
      'src/components/portal/dashboard/stat-card.tsx',
      'src/components/portal/contact-language-form.tsx',
      'src/components/benefits/benefit-usage-card.tsx',
      'src/components/data-export/data-export-panel.tsx',
      'src/components/directory/directory-visibility-form.tsx',
      'src/components/members/change-requests/pending-request-banner.tsx',
      'src/components/members/change-requests/change-request-diff-table.tsx',
      'src/components/members/timeline-event-item.tsx',
      'src/components/members/portal-edit-form.tsx',
      'src/components/members/invite-colleague-form.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it("except the benefits page's E-Blast tab, which moves with US12", async () => {
      expect(
        await ratchetHits(legacy, 'src/app/(member)/portal/benefits/_components/broadcasts-panel.tsx'),
      ).toEqual([]);
    });

  });

  describe('the US4 member invoices are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(member)/portal/invoices/page.tsx',
      'src/app/(member)/portal/invoices/loading.tsx',
      'src/app/(member)/portal/invoices/error.tsx',
      'src/app/(member)/portal/invoices/_components/portal-invoice-card-list.tsx',
      'src/app/(member)/portal/invoices/_components/resend-invoice-button.tsx',
      'src/app/(member)/portal/invoices/_components/receipt-status-watcher.tsx',
      'src/app/(staff)/admin/invoices/_components/invoice-filters.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/page.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/loading.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/not-found.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/_components/online-payment-disabled-card.tsx',
      'src/components/shell/live-region.tsx',
      'src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx',
      'src/app/(member)/portal/credit-notes/[creditNoteId]/loading.tsx',
      'src/components/invoices/credit-note-original-receipt.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/index.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/method-tabs.tsx',
      'src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/payment-failure-panel.tsx',
      'src/components/payments/pay-sheet-skeleton.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the audit log keeps the legacy kit until US10', async () => {
      expect(await ratchetHits(legacy, 'src/app/(staff)/admin/audit/loading.tsx')).toEqual([]);
    });
  });

  describe('the US5a members list, directory and change requests are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/members/page.tsx',
      'src/app/(staff)/admin/members/loading.tsx',
      'src/app/(staff)/admin/members/_components/bulk-action-bar.tsx',
      'src/app/(staff)/admin/members/_components/archive-confirm-dialog.tsx',
      'src/app/(staff)/admin/members/_components/bulk-progress-indicator.tsx',
      'src/components/members/members-table.tsx',
      'src/components/members/members-table-skeleton.tsx',
      'src/components/members/directory-filters.tsx',
      'src/components/members/empty-states.tsx',
      'src/app/(staff)/admin/directory/page.tsx',
      'src/app/(staff)/admin/directory/error.tsx',
      'src/components/directory/directory-table.tsx',
      'src/components/directory/recent-exports.tsx',
      'src/app/(staff)/admin/change-requests/page.tsx',
      'src/app/(staff)/admin/change-requests/_components/queue-filters.tsx',
      'src/app/(staff)/admin/change-requests/[id]/page.tsx',
      'src/app/(staff)/admin/change-requests/[id]/not-found.tsx',
      'src/components/members/change-requests/change-request-review-client.tsx',
      'src/components/members/change-requests/change-request-decision-table.tsx',
      'src/app/test-fixtures/aura-admin/page.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

  });

  describe('the US5b-1 member detail, timeline, benefits and their dialogs are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/members/[memberId]/page.tsx',
      'src/app/(staff)/admin/members/[memberId]/loading.tsx',
      'src/app/(staff)/admin/members/[memberId]/error.tsx',
      'src/app/(staff)/admin/members/[memberId]/_components/member-detail-view.tsx',
      'src/app/(staff)/admin/members/[memberId]/_components/member-invoices-section.tsx',
      'src/app/(staff)/admin/members/[memberId]/_lib/member-outstanding.ts',
      'src/app/(staff)/admin/members/[memberId]/timeline/page.tsx',
      'src/app/(staff)/admin/members/[memberId]/benefits/page.tsx',
      'src/components/members/contact-form-dialog.tsx',
      'src/components/members/contact-actions.tsx',
      'src/components/members/archive-member-button.tsx',
      'src/components/members/erase-member-button.tsx',
      'src/components/members/archived-banner.tsx',
      'src/components/members/restore-primary-dialog.tsx',
      'src/components/members/erased-banner.tsx',
      'src/components/members/no-primary-contact-banner.tsx',
      'src/components/members/renewal-health-card.tsx',
      'src/components/members/renew-lapsed-member-dialog.tsx',
      'src/components/members/marketing-switch.tsx',
      'src/components/members/marketing-state-badge.tsx',
      'src/components/members/invite-portal-button.tsx',
      'src/components/members/resend-bounced-invite-button.tsx',
      'src/components/members/resend-verification-button.tsx',
      'src/components/members/member-detail-skeleton.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

  });

  describe('the US5b-2 member forms, their dialogs and the notification-language card are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/members/new/page.tsx',
      'src/app/(staff)/admin/members/new/loading.tsx',
      'src/app/(staff)/admin/members/[memberId]/edit/page.tsx',
      'src/app/(staff)/admin/members/[memberId]/edit/loading.tsx',
      'src/app/(staff)/admin/members/[memberId]/edit/error.tsx',
      'src/components/members/member-form/member-form.tsx',
      'src/components/members/member-form/form-section-card.tsx',
      'src/components/members/member-form/sections/address-section.tsx',
      'src/components/members/member-form/sections/company-section.tsx',
      'src/components/members/member-form/sections/contact-fields.tsx',
      'src/components/members/member-form-skeleton.tsx',
      'src/components/members/country-combobox.tsx',
      'src/components/members/create-member-client.tsx',
      'src/components/members/edit-member-client.tsx',
      'src/components/members/plan-change-confirm-dialog.tsx',
      'src/components/members/bundle-change-warning-dialog.tsx',
      'src/components/members/override-reason-dialog.tsx',
      'src/components/members/soft-duplicate-dialog.tsx',
      'src/components/admin/admin-preferred-locale-card.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the member picker keeps the legacy kit until the invoice forms move (US8)', async () => {
      expect(await ratchetHits(legacy, 'src/components/members/member-picker.tsx')).toEqual([]);
    });
  });

  describe('the US6 plans pages are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/plans/page.tsx',
      'src/app/(staff)/admin/plans/loading.tsx',
      'src/app/(staff)/admin/plans/error.tsx',
      'src/app/(staff)/admin/plans/[year]/[planId]/page.tsx',
      'src/app/(staff)/admin/plans/[year]/[planId]/edit/page.tsx',
      'src/app/(staff)/admin/plans/new/new-plan-client.tsx',
      'src/app/(staff)/admin/plans/clone/clone-year-client.tsx',
      'src/components/plans/plans-table.tsx',
      'src/components/plans/plan-form-wizard.tsx',
      'src/components/plans/plan-edit-form.tsx',
      'src/components/plans/benefit-matrix-editor.tsx',
      'src/components/plans/clone-year-dialog.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the member picker keeps the legacy kit until the invoice forms move (US8)', async () => {
      expect(await ratchetHits(legacy, 'src/components/members/member-picker.tsx')).toEqual([]);
    });
  });

  describe('the US7a renewals pipeline page is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/renewals/page.tsx',
      'src/app/(staff)/admin/renewals/loading.tsx',
      'src/app/(staff)/admin/renewals/_components/pipeline-table.tsx',
      'src/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog.tsx',
      'src/app/(staff)/admin/renewals/_components/empty-state.tsx',
      'src/components/renewals/urgency-pill.tsx',
      'src/components/renewals/month-bar-chart.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('the renewal tasks page is on AURA too since US7b-2', async () => {
      expect(await ratchetHits(legacy, 'src/app/(staff)/admin/renewals/tasks/page.tsx')).toHaveLength(1);
    });
  });

  describe('the US7b-1 cycle detail and tier upgrade pages are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/renewals/[cycleId]/page.tsx',
      'src/app/(staff)/admin/renewals/[cycleId]/loading.tsx',
      'src/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions.tsx',
      'src/app/(staff)/admin/renewals/[cycleId]/_components/pending-reactivation-actions.tsx',
      'src/app/(staff)/admin/renewals/tier-upgrades/page.tsx',
      'src/app/(staff)/admin/renewals/tier-upgrades/loading.tsx',
      'src/app/(staff)/admin/renewals/tier-upgrades/error.tsx',
      'src/app/(staff)/admin/renewals/tier-upgrades/_components/tier-upgrade-queue.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

  });

  describe('the US7b-2 escalation tasks and reminder schedules are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/renewals/tasks/page.tsx',
      'src/app/(staff)/admin/renewals/tasks/loading.tsx',
      'src/app/(staff)/admin/renewals/tasks/error.tsx',
      'src/app/(staff)/admin/renewals/tasks/_components/escalation-task-queue.tsx',
      'src/app/(staff)/admin/renewals/tasks/_components/reassign-task-dropdown.tsx',
      'src/app/(staff)/admin/settings/renewals/schedules/page.tsx',
      'src/app/(staff)/admin/settings/renewals/schedules/loading.tsx',
      'src/app/(staff)/admin/settings/renewals/schedules/error.tsx',
      'src/app/(staff)/admin/settings/renewals/schedules/_components/step-card.tsx',
      'src/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the settings hub keeps the legacy kit until US10', async () => {
      expect(await ratchetHits(legacy, 'src/app/(staff)/admin/settings/page.tsx')).toEqual([]);
    });
  });

  describe('the US7c portal renewal pages are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(member)/portal/renewal/[memberId]/page.tsx',
      'src/app/(member)/portal/renewal/[memberId]/loading.tsx',
      'src/app/(member)/portal/renewal/[memberId]/error.tsx',
      'src/app/(member)/portal/renewal/[memberId]/_components/renewal-confirm-flow.tsx',
      'src/app/(member)/portal/renewal/[memberId]/_components/downgrade-confirm-dialog.tsx',
      'src/app/(member)/portal/renewal/[memberId]/_components/renewal-page-view.tsx',
      'src/app/(member)/portal/renewal/[memberId]/success/page.tsx',
      'src/app/(member)/portal/renewal/[memberId]/success/loading.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the member E-Blast pages keep the legacy kit until US12', async () => {
      expect(await ratchetHits(legacy, 'src/app/(member)/portal/broadcasts/[id]/page.tsx')).toEqual([]);
    });
  });

  describe('the US8a invoice list and new invoice are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/invoices/page.tsx',
      'src/app/(staff)/admin/invoices/loading.tsx',
      'src/app/(staff)/admin/invoices/error.tsx',
      'src/app/(staff)/admin/invoices/_lib/download-receipt-client.ts',
      'src/app/(staff)/admin/invoices/_components/invoices-list-view.tsx',
      'src/app/(staff)/admin/invoices/_components/invoice-table.tsx',
      'src/app/(staff)/admin/invoices/_components/invoices-table-skeleton.tsx',
      'src/app/(staff)/admin/invoices/_components/invoices-table-columns.ts',
      'src/app/(staff)/admin/invoices/_components/invoices-export-actions.tsx',
      'src/app/(staff)/admin/invoices/_components/auto-renewal-queue-actions.tsx',
      'src/app/(staff)/admin/invoices/_components/auto-renewal-queue-badges.tsx',
      'src/app/(staff)/admin/invoices/_components/csv-export-dialog.tsx',
      'src/app/(staff)/admin/invoices/_components/record-payment-dialog.tsx',
      'src/app/(staff)/admin/invoices/_components/payment-form.tsx',
      'src/app/(staff)/admin/invoices/_components/invoice-form.tsx',
      'src/app/(staff)/admin/invoices/_components/record-payment-error-routing.ts',
      'src/app/(staff)/admin/invoices/new/page.tsx',
      'src/app/(staff)/admin/invoices/new/loading.tsx',
      'src/app/(staff)/admin/invoices/new/_components/invoice-create-switcher.tsx',
      'src/app/(staff)/admin/invoices/new/_components/event-fee-form.tsx',
      'src/app/(staff)/admin/invoices/new/_components/event-attendee-picker.tsx',
      'src/app/(staff)/admin/invoices/new/_components/non-member-buyer-fields.tsx',
      'src/components/invoices/invoice-status-tone.ts',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

    it('control: the users page keeps the legacy kit until US10', async () => {
      expect(await ratchetHits(legacy, 'src/app/(staff)/admin/users/page.tsx')).toEqual([]);
    });
  });

  describe('the US8b invoice detail, its dialogs, void and new credit note are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/invoices/[invoiceId]/page.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/loading.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/not-found.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-action-bar.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-skeleton.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/copy-charge-id-button.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/issue-credit-note-action.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/index.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/typed-phrase-confirm.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/void/page.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/void/loading.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-confirm-dialog.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/page.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/loading.tsx',
      'src/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form.tsx',
      'src/app/(staff)/admin/invoices/_components/issue-invoice-dialog.tsx',
      'src/app/(staff)/admin/invoices/_components/issue-invoice-form.tsx',
      'src/app/(staff)/admin/invoices/_components/zero-rate-cert-uploader.tsx',
      'src/app/(staff)/admin/invoices/_components/delete-draft-dialog.tsx',
      'src/app/(staff)/admin/invoices/_components/email-failure-alert.tsx',
      'src/app/(staff)/admin/invoices/_components/auto-refund-failed-alert.tsx',
      'src/app/(staff)/admin/invoices/_components/invoice-more-menu.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });
  describe('the US8c-1 credit notes and tax registers are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/credit-notes/page.tsx',
      'src/app/(staff)/admin/credit-notes/loading.tsx',
      'src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx',
      'src/app/(staff)/admin/credit-notes/[creditNoteId]/loading.tsx',
      'src/app/(staff)/admin/credit-notes/[creditNoteId]/not-found.tsx',
      'src/app/(staff)/admin/credit-notes/_components/credit-notes-list-view.tsx',
      'src/app/(staff)/admin/credit-notes/_components/credit-notes-table.tsx',
      'src/app/(staff)/admin/credit-notes/_components/credit-note-filters.tsx',
      'src/app/(staff)/admin/credit-notes/_components/credit-note-detail-view.tsx',
      'src/app/(staff)/admin/credit-notes/_components/credit-note-actions.tsx',
      'src/app/(staff)/admin/invoices/registers/page.tsx',
      'src/app/(staff)/admin/invoices/registers/loading.tsx',
      'src/app/(staff)/admin/invoices/registers/_components/tax-register-form.tsx',
      'src/app/(staff)/admin/invoices/registers/_components/tax-register-view.tsx',
      'src/app/(staff)/admin/invoices/registers/_components/tax-register-table.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });
  describe('the US8c-2 invoice settings are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/settings/invoicing/page.tsx',
      'src/app/(staff)/admin/settings/invoicing/loading.tsx',
      'src/app/(staff)/admin/settings/invoicing/_components/invoice-settings-view.tsx',
      'src/components/invoices/invoice-settings-form.tsx',
      'src/components/invoices/invoice-settings/section-nav.tsx',
      'src/components/invoices/invoice-settings/sticky-save-bar.tsx',
      'src/components/invoices/invoice-settings/sections/organization-section.tsx',
      'src/components/invoices/invoice-settings/sections/branding-section.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });
  describe('the US9a events list and event detail are on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/events/page.tsx',
      'src/app/(staff)/admin/events/loading.tsx',
      'src/app/(staff)/admin/events/_components/events-list-view.tsx',
      'src/app/(staff)/admin/events/_components/events-header-menu.tsx',
      'src/app/(staff)/admin/events/_components/events-empty-state.tsx',
      'src/app/(staff)/admin/events/[eventId]/page.tsx',
      'src/app/(staff)/admin/events/[eventId]/loading.tsx',
      'src/components/events/events-list-filters.tsx',
      'src/components/events/events-list-table.tsx',
      'src/components/events/event-detail-header.tsx',
      'src/components/events/event-category-toggles.tsx',
      'src/components/events/archive-event-button.tsx',
      'src/components/events/attendee-table.tsx',
      'src/components/events/relink-registration-dialog.tsx',
      'src/components/events/match-status-badge.tsx',
      'src/components/events/quota-effect-badge.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });

  });
  describe('the US9b-1 events erasure is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/events/erasure/page.tsx',
      'src/app/(staff)/admin/events/erasure/loading.tsx',
      'src/app/(staff)/admin/events/erasure/error.tsx',
      'src/app/(staff)/admin/events/erasure/_components/erasure-view.tsx',
      'src/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/page.tsx',
      'src/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/loading.tsx',
      'src/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/error.tsx',
      'src/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/_components/erase-page-view.tsx',
      'src/components/events/erase-pii-dialog.tsx',
      'src/components/events/erase-by-email-panel.tsx',
      'src/components/events/erasure-results-table.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });
  describe('the US9b-2 events CSV import is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";

    it.each([
      'src/app/(staff)/admin/events/import/page.tsx',
      'src/app/(staff)/admin/events/import/loading.tsx',
      'src/app/(staff)/admin/events/import/history/page.tsx',
      'src/app/(staff)/admin/events/import/history/loading.tsx',
      'src/app/(staff)/admin/events/import/history/error.tsx',
      'src/components/events/csv-mapping-form.tsx',
      'src/components/events/event-picker.tsx',
      'src/components/events/event-create-inline-modal.tsx',
      'src/components/events/event-mismatch-warning-dialog.tsx',
      'src/components/events/csv-import-result.tsx',
      'src/components/events/csv-import-history-table.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });

  describe('the US9c EventCreate integration page is on AURA (the real MIGRATED_PATHS)', () => {
    const legacy = "import { Button } from '@/components/ui/button';\nexport const B = Button;\n";
    it.each([
      'src/app/(staff)/admin/settings/integrations/eventcreate/page.tsx',
      'src/app/(staff)/admin/settings/integrations/eventcreate/loading.tsx',
      'src/app/(staff)/admin/settings/integrations/eventcreate/error.tsx',
      'src/components/events/webhook-config-wizard.tsx',
      'src/components/events/webhook-secret-reveal.tsx',
      'src/components/events/webhook-value-box.tsx',
      'src/components/events/rotate-secret-dialog.tsx',
      'src/components/events/test-webhook-button.tsx',
      'src/components/events/recent-deliveries-panel.tsx',
      'src/components/events/zapier-walkthrough.tsx',
    ])('%s cannot import the legacy kit', async (path) => {
      expect(await ratchetHits(legacy, path)).toHaveLength(1);
    });
  });
});
