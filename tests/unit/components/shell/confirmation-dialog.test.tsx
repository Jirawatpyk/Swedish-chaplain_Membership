// tests/unit/components/shell/confirmation-dialog.test.tsx
//
// UX-2 fix (post-review fix batch, 2026-07-18) — <ConfirmationDialog> is the
// shared destructive-action primitive (T134). A fast double-click on Confirm
// used to be able to fire `onConfirm` twice (no in-flight guard), which for
// an irreversible action (e.g. revoke-invite) fires the mutation twice and
// surfaces contradictory success + error toasts.
//
// Covers:
//  (a) basic render: title/description/labels
//  (b) Confirm disables BOTH Confirm and Cancel while `onConfirm` is
//      in-flight (a pending, not-yet-resolved promise) and shows a spinner
//  (c) once `onConfirm` resolves, the dialog closes (closeOnConfirm default)
//      and `onConfirm` was called exactly once — the double-fire guard holds
//      even when the caller does not disable anything itself
//  (d) `confirmDisabled` still blocks Confirm even when not submitting
//
// Real timers required (global setup enables fake timers — see
// tests/unit/broadcasts/components/cancel-broadcast-dialog.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderDialog(
  extra: Partial<React.ComponentProps<typeof ConfirmationDialog>> = {},
) {
  const onOpenChange = extra.onOpenChange ?? vi.fn();
  const onConfirm = extra.onConfirm ?? vi.fn().mockResolvedValue(undefined);
  render(
    <ConfirmationDialog
      open
      onOpenChange={onOpenChange}
      title="Revoke this invitation?"
      description="pending@example.com will no longer be able to accept this invitation."
      confirmLabel="Revoke invitation"
      cancelLabel="Cancel"
      destructive
      {...extra}
      onConfirm={onConfirm}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe('ConfirmationDialog', () => {
  it('renders title, description, and button labels', () => {
    renderDialog();
    expect(screen.getByText('Revoke this invitation?')).toBeInTheDocument();
    expect(
      screen.getByText('pending@example.com will no longer be able to accept this invitation.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke invitation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('disables BOTH Confirm and Cancel while onConfirm is in-flight (double-fire guard)', async () => {
    const gate = deferred<void>();
    const onConfirm = vi.fn().mockReturnValue(gate.promise);
    renderDialog({ onConfirm });

    const confirmBtn = screen.getByRole('button', { name: 'Revoke invitation' });
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });

    fireEvent.click(confirmBtn);

    // onConfirm fires synchronously up to its own first await/return, so the
    // call itself has happened, but the promise it returned is still
    // pending — both buttons must be disabled for the duration.
    await waitFor(() => expect(confirmBtn).toBeDisabled());
    expect(cancelBtn).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // A second click while still pending must NOT re-invoke onConfirm.
    // (The DOM `disabled` attribute already blocks this natively; the
    // internal `submitting` guard is defense-in-depth for a programmatic
    // dispatch that bypasses `disabled`.)
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
  });

  it('shows a spinner in the Confirm button while submitting', async () => {
    const gate = deferred<void>();
    renderDialog({ onConfirm: vi.fn().mockReturnValue(gate.promise) });

    const confirmBtn = screen.getByRole('button', { name: /Revoke invitation/ });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(confirmBtn.querySelector('svg')).toBeInTheDocument());

    gate.resolve();
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
  });

  it('closes the dialog after onConfirm resolves (closeOnConfirm default true)', async () => {
    const { onOpenChange, onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirmDisabled blocks Confirm even when not submitting', () => {
    const onConfirm = vi.fn();
    renderDialog({ confirmDisabled: true, onConfirm });

    const confirmBtn = screen.getByRole('button', { name: 'Revoke invitation' });
    expect(confirmBtn).toBeDisabled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
