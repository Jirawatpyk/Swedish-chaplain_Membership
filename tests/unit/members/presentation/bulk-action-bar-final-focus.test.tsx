/**
 * BulkActionBar — focus must not drop to `<body>` after a successful bulk
 * action (107-auto-invoice Task 15 review UX-1; WCAG 2.1 AA SC 2.4.3).
 *
 * The bug: EVERY successful bulk action calls `onClear()`, the parent clears
 * `selectedIds`, `count === 0`, and the bar returns `null` — so the trigger
 * button that opened the dialog is GONE by the time focus-return runs. Base
 * UI's default finalFocus targets that vanished trigger, and focus silently
 * lands on `<body>`: a keyboard or screen-reader user must re-Tab from the
 * top of the page after every action.
 *
 * This affects all three actions (Archive and Send-invite pre-existed; Task 15
 * added Enrol), so all three are asserted.
 *
 * Why this test is shaped the way it is:
 *
 *   - The parent is a REAL stateful component whose `onClear` actually drops
 *     the selection, so the bar genuinely unmounts. A `vi.fn()` onClear or a
 *     no-op `router.refresh` would leave the trigger mounted and the
 *     assertion would pass against the unfixed code — proving nothing.
 *   - Base UI's AlertDialog deadlocks under jsdom + React 19 startTransition
 *     (documented in `approve-reject-final-focus.test.ts`), so the dialog is
 *     replaced by a stand-in that reproduces Base UI's CONTRACT: after
 *     `onConfirm` resolves, it calls `finalFocus()` and focuses the result.
 *     Everything under test is real — the component, `useDialogFinalFocus`,
 *     `resolveDialogFinalFocus`, the trigger refs, and the success flag.
 *   - The assertion is direct (`document.activeElement`), not a source grep,
 *     and `@a11y`/axe cannot catch this class at all (it does not check focus
 *     after unmount).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));

/**
 * Base UI stand-in shared by both dialog components. Reproduces the ONE
 * behaviour under test: on close after a resolved `onConfirm`, ask
 * `finalFocus()` where focus should go and put it there.
 */
function makeDialogStub(testId: string) {
  return function DialogStub({
    open,
    onConfirm,
    finalFocus,
  }: {
    open: boolean;
    onConfirm: () => void | Promise<void>;
    finalFocus?: () => HTMLElement | null;
  }) {
    if (!open) return null;
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={async () => {
          await onConfirm();
          // Base UI computes finalFocus at close and focuses it.
          const target = finalFocus?.() ?? null;
          target?.focus();
        }}
      >
        confirm
      </button>
    );
  };
}

vi.mock('@/app/(staff)/admin/members/_components/archive-confirm-dialog', () => ({
  ArchiveConfirmDialog: makeDialogStub('confirm-dialog'),
}));
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: makeDialogStub('confirm-dialog'),
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

const MEMBER_UUID = '11111111-2222-3333-4444-555555555555';

/** Real stateful parent — `onClear` genuinely removes the selection. */
function Harness() {
  const [selectedIds, setSelectedIds] = useState<string[]>([MEMBER_UUID]);
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkActionBar
        selectedIds={selectedIds}
        selectedCompanyNames={['Acme Co']}
        totalMatching={1}
        onClear={() => setSelectedIds([])}
      />
    </NextIntlClientProvider>
  );
}

let mainContent: HTMLElement;

beforeEach(() => {
  // REQUIRED — the shared test setup installs fake timers, and `waitFor`
  // schedules its retries on them, so without this every async assertion
  // spins until the 30s test timeout instead of resolving. Same guard as
  // `bulk-action-bar-error-map.test.tsx`.
  vi.useRealTimers();

  // The staff layout's `<main id="main-content" tabIndex={-1}>` landmark —
  // the surviving focus target `resolveDialogFinalFocus` falls back to.
  mainContent = document.createElement('main');
  mainContent.id = 'main-content';
  mainContent.tabIndex = -1;
  document.body.appendChild(mainContent);

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        updated_count: 1,
        audit_event_count: 1,
        counts: { invited: 1, skipped: 0, failed: 0 },
        enrolled: 1,
        skipped_already: 0,
        skipped_terminated: 0,
      }),
    }),
  );
  // NOTE: do NOT stub global `crypto` here. `executeBulk` only needs
  // `crypto.randomUUID()` (present in Node 22's webcrypto), and replacing the
  // global with a spread object silently drops every prototype method
  // (`getRandomValues` etc.) that jsdom/React rely on — which hangs the
  // render instead of failing, costing a 30s timeout per test.
});

afterEach(() => {
  mainContent.remove();
  vi.unstubAllGlobals();
});

describe('BulkActionBar — focus survives the bar unmounting (SC 2.4.3)', () => {
  const ACTIONS = [
    { label: /^Archive$/, name: 'archive' },
    { label: /^Send invite$/, name: 'send_portal_invite' },
    { label: /^Enrol in auto-invoicing$/, name: 'enrol_auto_invoice' },
  ] as const;

  for (const { label, name } of ACTIONS) {
    it(`${name}: focus lands on a real element, not <body>, after success`, async () => {
      render(<Harness />);

      const trigger = screen.getByRole('button', { name: label });
      fireEvent.click(trigger);

      fireEvent.click(screen.getByTestId('confirm-dialog'));

      // The whole bar must actually be gone — otherwise this test would
      // pass against the unfixed code.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: label })).toBeNull();
      });
      expect(trigger.isConnected).toBe(false);

      // The actual regression guard.
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(mainContent);
    });
  }

  it('returns focus to the trigger when the action FAILS (bar survives)', async () => {
    // A failed action does not call onClear(), so the trigger is still
    // mounted and Base UI's normal behaviour — return to the trigger — is
    // correct. This pins the `closedViaSuccessRef` reset: without it, a
    // failure after an earlier success would wrongly punt focus to the
    // landmark instead of the button the user actually pressed.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'server_error' } }),
      }),
    );
    render(<Harness />);

    const trigger = screen.getByRole('button', {
      name: /^Enrol in auto-invoicing$/,
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('confirm-dialog'));

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    expect(trigger.isConnected).toBe(true);
  });
});
