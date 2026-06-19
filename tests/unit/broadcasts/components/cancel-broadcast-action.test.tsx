// tests/unit/broadcasts/components/cancel-broadcast-action.test.tsx
/**
 * DV-12 — Unit tests for the unified <CancelBroadcastAction> (review #13).
 *
 * Covers BOTH surfaces (admin reason-required + member reason-optional) of the
 * single component that replaced admin-cancel-action / member-cancel-action.
 *
 * The trigger button and the in-dialog confirm share the same accessible name
 * ("Cancel broadcast") on both surfaces, so we click the trigger while the
 * dialog is closed (only the trigger exists then) and scope in-dialog queries
 * with within(dialog) — never index-last (review #10).
 *
 * Pattern: real NextIntlClientProvider + real en.json; mock fetch/router/sonner.
 * Real timers via vi.useRealTimers() (global setup fakes them).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  // Restore the per-test fetch spy so its impl never leaks into a later test
  // (safe — restoreAllMocks restores vi.spyOn spies, not the vi.mock factories).
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

function renderAction(
  surface: 'admin' | 'member',
  broadcastId = 'b1',
  variant?: 'cancel' | 'halt',
) {
  // Branch on the literal surface so the discriminated CancelBroadcastActionProps
  // narrows ('member' cannot take a variant; 'admin' may take 'cancel' | 'halt').
  const action =
    surface === 'admin' ? (
      <CancelBroadcastAction
        broadcastId={broadcastId}
        surface="admin"
        {...(variant ? { variant } : {})}
      />
    ) : (
      <CancelBroadcastAction broadcastId={broadcastId} surface="member" />
    );
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      {action}
    </NextIntlClientProvider>,
  );
}

// ── Admin surface (reason required) ─────────────────────────────────────

describe('CancelBroadcastAction (admin surface)', () => {
  const triggerName = en.admin.broadcasts.cancelDialog.confirm;

  it('renders the trigger button', () => {
    renderAction('admin');
    expect(screen.getByRole('button', { name: triggerName })).toBeInTheDocument();
  });

  it('opens the admin cancel dialog when the trigger is clicked', async () => {
    renderAction('admin');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    expect(
      await screen.findByText(en.admin.broadcasts.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('dialog requires a reason (confirm disabled initially)', async () => {
    renderAction('admin');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.admin.broadcasts.cancelDialog.title);
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    ).toBeDisabled();
  });

  it('fires the admin cancel endpoint with the typed reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('admin', 'broadcast-xyz');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.admin.broadcasts.cancelDialog.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(
      within(dialog).getByLabelText(
        new RegExp(en.admin.broadcasts.cancelDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'test cancellation reason' } },
    );
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: en.admin.broadcasts.cancelDialog.confirm,
      }),
    );

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

// ── Member surface (reason optional) ────────────────────────────────────

describe('CancelBroadcastAction (member surface)', () => {
  const triggerName = en.portal.broadcasts.detail.cancelButton;
  const memberReasonLabel = new RegExp(
    en.portal.broadcasts.detail.cancelDialog.reasonLabel.replace(/[()]/g, '\\$&'),
    'i',
  );

  it('renders the trigger button with the member label', () => {
    renderAction('member');
    expect(screen.getByRole('button', { name: triggerName })).toBeInTheDocument();
  });

  it('opens the member cancel dialog when the trigger is clicked', async () => {
    renderAction('member');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    expect(
      await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title),
    ).toBeInTheDocument();
  });

  it('dialog does NOT require a reason (confirm enabled without input)', async () => {
    renderAction('member');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    ).not.toBeDisabled();
  });

  it('fires the member cancel endpoint with no reason on empty submit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('member', 'broadcast-xyz');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/broadcasts/broadcast-xyz/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    });
  });

  it('fires the member cancel endpoint with the optional reason when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('member', 'broadcast-abc');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.portal.broadcasts.detail.cancelDialog.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(memberReasonLabel), {
      target: { value: 'changing my mind' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: en.portal.broadcasts.detail.cancelDialog.confirm,
      }),
    );

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

// ── Admin halt variant (F7.1a mid-dispatch halt) ────────────────────────

describe('CancelBroadcastAction (admin halt variant)', () => {
  const triggerName = en.admin.broadcasts.haltDialog.confirm; // "Halt sending"

  it('renders the Halt sending trigger', () => {
    renderAction('admin', 'b1', 'halt');
    expect(screen.getByRole('button', { name: triggerName })).toBeInTheDocument();
  });

  it('opens the halt dialog when the trigger is clicked', async () => {
    renderAction('admin', 'b1', 'halt');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    expect(
      await screen.findByText(en.admin.broadcasts.haltDialog.title),
    ).toBeInTheDocument();
  });

  it('fires the same admin /cancel endpoint with the typed reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    renderAction('admin', 'broadcast-halt', 'halt');
    fireEvent.click(screen.getByRole('button', { name: triggerName }));
    await screen.findByText(en.admin.broadcasts.haltDialog.title);

    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(
      within(dialog).getByLabelText(
        new RegExp(en.admin.broadcasts.haltDialog.reasonLabel, 'i'),
      ),
      { target: { value: 'complaint spike — stop now' } },
    );
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: en.admin.broadcasts.haltDialog.confirm,
      }),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/admin/broadcasts/broadcast-halt/cancel',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cancellationReason: 'complaint spike — stop now' }),
        }),
      );
    });
  });
});
