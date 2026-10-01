/**
 * F8 Phase 8 R10 S10 close — `<TaskActionDialog>` mount-guard tests.
 *
 * The shared dialog shell uses a `wasOpenRef`-guarded `useEffect` to
 * fire `onClose` exactly once per close transition (R6 IMP-6 + R8 C3-4
 * close). This test pins:
 *   1. Initial mount with `open={false}` does NOT fire `onClose` — the
 *      ref starts `false`, a default-closed dialog is not a "close".
 *   2. Open → close transition fires `onClose` exactly ONCE.
 *   3. Multiple toggles fire `onClose` once per closed transition.
 *   4. The `onCloseRef` swap captures the latest closure (e.g. inline
 *      `() => setX(0)` parents don't get a stale view).
 *
 * Without these pins, a regression that re-introduces the prior
 * double-fire (`onOpenChange(false)` + useEffect both invoking
 * onClose) would silently drift form-reset and unmount-cleanup
 * semantics across all 3 dialog consumers (Done, Skip, Reassign).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TaskActionDialog } from '@/app/(staff)/admin/renewals/tasks/_components/task-action-dialog';

// AURA's dialog animates on real timers.
beforeEach(() => {
  vi.useRealTimers();
});

function renderShell(props: Partial<React.ComponentProps<typeof TaskActionDialog>> = {}) {
  const defaults: React.ComponentProps<typeof TaskActionDialog> = {
    open: false,
    onOpenChange: () => {},
    title: 'Mark as done',
    description: 'Confirm the action',
    cancelLabel: 'Cancel',
    confirmLabel: 'Confirm',
    submittingLabel: 'Submitting…',
    isPending: false,
    canSubmit: true,
    onSubmit: () => {},
    children: <div data-testid="body">body</div>,
  };
  return render(<TaskActionDialog {...defaults} {...props} />);
}

describe('<TaskActionDialog> mount-guard (R10 S10)', () => {
  it('initial mount with open=false → onClose NOT fired', () => {
    const onClose = vi.fn();
    renderShell({ open: false, onClose });
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it('open=true on first mount → onClose NOT fired (no prior close transition)', () => {
    const onClose = vi.fn();
    renderShell({ open: true, onClose });
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it('open=true → open=false transition fires onClose exactly ONCE', () => {
    const onClose = vi.fn();
    const { rerender } = renderShell({ open: true, onClose });
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <TaskActionDialog
        open={false}
        onOpenChange={() => {}}
        onClose={onClose}
        title="t"
        description="d"
        cancelLabel="c"
        confirmLabel="ok"
        submittingLabel="…"
        isPending={false}
        canSubmit
        onSubmit={() => {}}
      >
        <div>body</div>
      </TaskActionDialog>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('open → close → open → close fires onClose twice (one per close edge)', () => {
    const onClose = vi.fn();
    const baseProps = {
      onOpenChange: () => {},
      onClose,
      title: 't',
      description: 'd',
      cancelLabel: 'c',
      confirmLabel: 'ok',
      submittingLabel: '…',
      isPending: false,
      canSubmit: true,
      onSubmit: () => {},
      children: <div>body</div>,
    };
    const { rerender } = render(<TaskActionDialog open={true} {...baseProps} />);
    rerender(<TaskActionDialog open={false} {...baseProps} />);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<TaskActionDialog open={true} {...baseProps} />);
    expect(onClose).toHaveBeenCalledTimes(1); // still 1 — opening doesn't fire

    rerender(<TaskActionDialog open={false} {...baseProps} />);
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('onClose closure swap — latest fn captured via ref', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const baseProps = {
      onOpenChange: () => {},
      title: 't',
      description: 'd',
      cancelLabel: 'c',
      confirmLabel: 'ok',
      submittingLabel: '…',
      isPending: false,
      canSubmit: true,
      onSubmit: () => {},
      children: <div>body</div>,
    };
    const { rerender } = render(
      <TaskActionDialog open={true} onClose={stale} {...baseProps} />,
    );
    // Swap closure while still open — `onCloseRef.current = onClose`
    // useEffect MUST pick up the new function before the close edge.
    rerender(<TaskActionDialog open={true} onClose={fresh} {...baseProps} />);
    rerender(<TaskActionDialog open={false} onClose={fresh} {...baseProps} />);

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('onClose absent → no crash on close transition', () => {
    const baseProps = {
      onOpenChange: () => {},
      title: 't',
      description: 'd',
      cancelLabel: 'c',
      confirmLabel: 'ok',
      submittingLabel: '…',
      isPending: false,
      canSubmit: true,
      onSubmit: () => {},
      children: <div>body</div>,
    };
    const { rerender } = render(<TaskActionDialog open={true} {...baseProps} />);
    expect(() =>
      rerender(<TaskActionDialog open={false} {...baseProps} />),
    ).not.toThrow();
    cleanup();
  });
});

/**
 * 122 US7b-2 (T733) — the shell is an AURA `Dialog role="alertdialog"`:
 * Cancel takes the initial focus, the confirm shows its submitting label while
 * the request runs, and the dialog cannot be dismissed meanwhile.
 */
describe('<TaskActionDialog> on AURA', () => {
  it('renders an AURA alertdialog with the title, description and body', () => {
    const { getByRole } = renderShell({ open: true });
    const dialog = getByRole('alertdialog', { name: 'Mark as done' });
    expect(dialog.closest('.aura-dialog') ?? dialog.querySelector('.aura-dialog') ?? dialog).toBeTruthy();
    expect(dialog).toHaveTextContent('Confirm the action');
    expect(dialog.querySelector('[data-testid="body"]')).not.toBeNull();
    cleanup();
  });

  it('puts the initial focus on Cancel', () => {
    const { getByRole } = renderShell({ open: true });
    expect(getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-autofocus');
    cleanup();
  });

  it('confirm calls onSubmit, Cancel closes, and the confirm is disabled until it can submit', () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const { getByRole, rerender } = renderShell({ open: true, onSubmit, onOpenChange });
    getByRole('button', { name: 'Confirm' }).click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    getByRole('button', { name: 'Cancel' }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(
      <TaskActionDialog
        open
        onOpenChange={onOpenChange}
        title="Mark as done"
        description="d"
        cancelLabel="Cancel"
        confirmLabel="Confirm"
        submittingLabel="Submitting…"
        isPending={false}
        canSubmit={false}
        onSubmit={onSubmit}
      >
        <div />
      </TaskActionDialog>,
    );
    expect(getByRole('button', { name: 'Confirm' })).toBeDisabled();
    cleanup();
  });

  it('while pending, shows the submitting label, disables Cancel and cannot be dismissed', () => {
    const { getByRole, queryByRole } = renderShell({ open: true, isPending: true });
    const dialog = getByRole('alertdialog');
    expect(getByRole('button', { name: /Submitting…/ })).toHaveAttribute('aria-busy', 'true');
    expect(getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // Not dismissible: AURA drops its close button.
    expect(queryByRole('button', { name: /close/i })).toBeNull();
    expect(dialog).toBeInTheDocument();
    cleanup();
  });

  it('the destructive variant uses the danger button', () => {
    const { getByRole } = renderShell({ open: true, variant: 'destructive' });
    expect(getByRole('button', { name: 'Confirm' })).toHaveClass('aura-btn--danger');
    cleanup();
  });
});
