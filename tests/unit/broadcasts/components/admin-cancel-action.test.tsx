// tests/unit/broadcasts/components/admin-cancel-action.test.tsx
/**
 * DV-12 — Task 3: Unit tests for <AdminCancelAction>.
 *
 * Verifies: trigger button renders; clicking it opens the shared
 * CancelBroadcastDialog (admin namespace + reasonRequired=true).
 *
 * Pattern: real NextIntlClientProvider + real en.json; mock
 * fetch/router/sonner (mirrors cancel-broadcast-dialog.test.tsx).
 * Real timers via vi.useRealTimers() (global setup fakes them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AdminCancelAction } from '@/components/broadcast/admin/admin-cancel-action';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

function renderAction(broadcastId = 'b1') {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AdminCancelAction broadcastId={broadcastId} />
    </NextIntlClientProvider>,
  );
}

describe('AdminCancelAction', () => {
  it('renders the trigger button with Cancel broadcast label', () => {
    renderAction();
    expect(
      screen.getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    ).toBeInTheDocument();
  });

  it('opens the cancel dialog when trigger is clicked', async () => {
    renderAction();
    const trigger = screen.getByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    fireEvent.click(trigger);
    // Dialog title should appear (admin namespace)
    expect(
      await screen.findByText(en.admin.broadcasts.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('dialog requires a reason (reasonRequired=true) — confirm disabled initially', async () => {
    renderAction();
    fireEvent.click(
      screen.getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    );
    // Wait for dialog to open
    await screen.findByText(en.admin.broadcasts.cancelDialog.title);
    // There will now be TWO buttons named "Cancel broadcast" — the trigger
    // (still in DOM) + the dialog action button. The dialog action should be
    // disabled because no reason has been typed.
    const buttons = screen.getAllByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    // At least the dialog action button is disabled (the reason is empty)
    const dialogActionBtn = buttons[buttons.length - 1];
    expect(dialogActionBtn).not.toBeUndefined();
    expect(dialogActionBtn).toBeDisabled();
  });

  it('fires the admin cancel endpoint with the typed reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('broadcast-xyz');

    // Open dialog
    fireEvent.click(
      screen.getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    );
    await screen.findByText(en.admin.broadcasts.cancelDialog.title);

    // Type a reason
    fireEvent.change(
      screen.getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'test cancellation reason' } },
    );

    // Click the confirm button inside the dialog
    const buttons = screen.getAllByRole('button', {
      name: en.admin.broadcasts.cancelDialog.confirm,
    });
    const dialogAction = buttons[buttons.length - 1];
    fireEvent.click(dialogAction!);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/broadcasts/broadcast-xyz/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cancellationReason: 'test cancellation reason' }),
        }),
      );
    });
  });
});
