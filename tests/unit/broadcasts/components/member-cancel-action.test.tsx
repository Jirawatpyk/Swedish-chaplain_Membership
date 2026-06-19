// tests/unit/broadcasts/components/member-cancel-action.test.tsx
/**
 * DV-12 — Task 4: Unit tests for <MemberCancelAction>.
 *
 * Verifies: trigger button renders with the member namespace label;
 * clicking it opens the shared CancelBroadcastDialog (member namespace,
 * reasonRequired=false); the dialog wires the correct member endpoint.
 *
 * Pattern: real NextIntlClientProvider + real en.json; mock
 * fetch/router/sonner (mirrors admin-cancel-action.test.tsx).
 * Real timers via vi.useRealTimers() (global setup fakes them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MemberCancelAction } from '@/app/(member)/portal/broadcasts/[id]/_components/member-cancel-action';

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
      <MemberCancelAction broadcastId={broadcastId} />
    </NextIntlClientProvider>,
  );
}

describe('MemberCancelAction', () => {
  it('renders the trigger button with member cancelButton label', () => {
    renderAction();
    expect(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelButton,
      }),
    ).toBeInTheDocument();
  });

  it('opens the cancel dialog when trigger is clicked', async () => {
    renderAction();
    const trigger = screen.getByRole('button', {
      name: en.portal.broadcasts.detail.cancelButton,
    });
    fireEvent.click(trigger);
    // Dialog title should appear (member namespace)
    expect(
      await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('dialog does NOT require a reason (reasonRequired=false) — confirm enabled without input', async () => {
    renderAction();
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelButton,
      }),
    );
    // Wait for dialog to open
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);
    // Scope to alertdialog to avoid trigger-button name ambiguity
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: en.portal.broadcasts.detail.cancelDialog.confirm,
    });
    // Member cancel: no reason required, so confirm is enabled immediately
    expect(confirmBtn).not.toBeDisabled();
  });

  it('fires the member cancel endpoint with no reason on empty submit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('broadcast-xyz');

    // Open dialog
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelButton,
      }),
    );
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);

    // Click confirm inside dialog without typing a reason
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: en.portal.broadcasts.detail.cancelDialog.confirm,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/broadcasts/broadcast-xyz/cancel',
        expect.objectContaining({
          method: 'POST',
          // Empty reason → body is {} (no cancellationReason key)
          body: JSON.stringify({}),
        }),
      );
    });
  });

  it('fires the member cancel endpoint with optional reason when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('broadcast-abc');

    // Open dialog
    fireEvent.click(
      screen.getByRole('button', {
        name: en.portal.broadcasts.detail.cancelButton,
      }),
    );
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);

    // Type an optional reason — use findByLabelText (async) to wait for the
    // dialog content to be fully rendered in jsdom; escape regex metacharacters
    // since the label "Reason (optional)" contains parentheses.
    const labelPattern = new RegExp(
      en.portal.broadcasts.detail.cancelDialog.reasonLabel.replace(
        /[$()*+.?[\\\]^{|}]/g,
        '\\$&',
      ),
      'i',
    );
    const textarea = await screen.findByLabelText(labelPattern);
    fireEvent.change(textarea, { target: { value: 'changing my mind' } });

    // Click confirm
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', {
      name: en.portal.broadcasts.detail.cancelDialog.confirm,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/broadcasts/broadcast-abc/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cancellationReason: 'changing my mind' }),
        }),
      );
    });
  });
});
