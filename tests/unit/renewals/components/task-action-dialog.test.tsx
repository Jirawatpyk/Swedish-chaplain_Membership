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
import { describe, it, expect, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TaskActionDialog } from '@/app/(staff)/admin/renewals/tasks/_components/task-action-dialog';

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
