/**
 * UX-audit PR-A #4/#5a — escalation-queue row actions collapse to
 * Done + a ⋯ overflow menu, and the launched dialogs receive a `finalFocus`.
 *
 * Base UI's DropdownMenu portal + AlertDialog lock up jsdom (see the sibling
 * `reassign-task-dropdown.test.tsx` note), so the dropdown-menu primitive is
 * mocked to render trigger + content eagerly, and the three dialog children are
 * mocked to a marker that exposes the `finalFocus` prop TYPE when open. That
 * keeps the assertions on THIS component's wiring (which action is a visible
 * button, which live in the menu, and that each dialog is handed a focus-return
 * resolver) without dragging Base UI's focus machinery into jsdom.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { buildFormats } from '@/i18n/formats';
import {
  EscalationTaskQueue,
  type EscalationTaskQueueItem,
} from '@/app/(staff)/admin/renewals/tasks/_components/escalation-task-queue';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// postAction toasts on success/failure — stub sonner so the success path in the
// close-time regression test below runs without a mounted <Toaster>.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// R3 — a spy standing in for Base UI's OWN trigger ref (arrives inside the
// render-prop `props` in React 19). The component must forward the DOM node to
// it via `mergeRefs(baseRef, rowMenuTriggerRef)`; a regression to
// `ref={rowMenuTriggerRef}` alone (the Base-UI ref-override trap that stops the
// menu from opening) would never call this spy. Hoisted so the vi.mock factory
// below can close over it.
const { baseRefSpy } = vi.hoisted(() => ({ baseRefSpy: vi.fn() }));

// Close-time capture for the Done dialog. Base UI reads `finalFocus` LIVE at
// close, so the ONLY way to catch a `finalFocus={doneDialogTarget?.finalFocus}`
// regression (the prop evaporates to `undefined` the instant the dialog closes
// on success) is to observe the value AFTER close. The mock records `finalFocus`
// + `onSubmit` on EVERY render, including the `open=false` close render.
const { doneCapture } = vi.hoisted(() => ({
  doneCapture: {
    finalFocus: undefined as unknown,
    onSubmit: undefined as
      | ((note: string | undefined) => Promise<void>)
      | undefined,
  },
}));

// Render the ⋯ menu trigger (function render-prop) + content eagerly so both
// the icon trigger and the Skip/Reassign items are queryable without opening a
// Base UI portal.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuTrigger: ({
      render,
    }: {
      render:
        | ((props: { ref: (el: unknown) => void }) => ReactNode)
        | ReactNode;
    }) =>
      typeof render === 'function'
        ? render({ ref: baseRefSpy })
        : (render ?? null),
    DropdownMenuContent: ({ children }: { children: ReactNode }) =>
      React.createElement('div', { role: 'menu' }, children),
    DropdownMenuItem: ({
      children,
      onClick,
    }: {
      children: ReactNode;
      onClick?: () => void;
    }) =>
      React.createElement(
        'button',
        { type: 'button', role: 'menuitem', onClick },
        children,
      ),
  };
});

vi.mock(
  '@/app/(staff)/admin/renewals/tasks/_components/done-task-dialog',
  async () => {
    const React = await import('react');
    return {
      DoneTaskDialog: ({
        open,
        finalFocus,
        onSubmit,
      }: {
        open: boolean;
        finalFocus?: unknown;
        onSubmit?: (note: string | undefined) => Promise<void>;
      }) => {
        // Capture on EVERY render (including the close render, open=false) so a
        // regression to `doneDialogTarget?.finalFocus` — undefined once the
        // target is nulled on success — is observable at close time.
        doneCapture.finalFocus = finalFocus;
        doneCapture.onSubmit = onSubmit;
        return open
          ? React.createElement('div', {
              'data-testid': 'done-dialog',
              'data-finalfocus-type': typeof finalFocus,
            })
          : null;
      },
    };
  },
);

vi.mock(
  '@/app/(staff)/admin/renewals/tasks/_components/skip-task-dialog',
  async () => {
    const React = await import('react');
    return {
      SkipTaskDialog: ({
        open,
        finalFocus,
      }: {
        open: boolean;
        finalFocus?: unknown;
      }) =>
        open
          ? React.createElement('div', {
              'data-testid': 'skip-dialog',
              'data-finalfocus-type': typeof finalFocus,
            })
          : null,
    };
  },
);

vi.mock(
  '@/app/(staff)/admin/renewals/tasks/_components/reassign-task-dropdown',
  async () => {
    const React = await import('react');
    return {
      ReassignTaskDropdown: ({
        open,
        finalFocus,
      }: {
        open: boolean;
        finalFocus?: unknown;
      }) =>
        open
          ? React.createElement('div', {
              'data-testid': 'reassign-dialog',
              'data-finalfocus-type': typeof finalFocus,
            })
          : null,
    };
  },
);

function makeTask(
  overrides: Partial<EscalationTaskQueueItem> & { taskId: string },
): EscalationTaskQueueItem {
  return {
    memberId: `member-${overrides.taskId}`,
    memberCompanyName: 'Acme Co',
    memberTierBucket: null,
    cycleId: null,
    cycleExpiresAt: null,
    taskType: 'manual_outreach_required',
    assignedToRole: 'admin',
    assignedToUserId: null,
    assignedToDisplayName: null,
    assignedToEmail: null,
    dueAt: '2026-04-10T00:00:00.000Z',
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
    yearInCycle: 1,
    totalYears: 1,
    ...overrides,
  };
}

function renderQueue(actorRole: 'admin' | 'manager' = 'admin') {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      formats={buildFormats('en')}
      timeZone="Asia/Bangkok"
    >
      {/* The real staff layout provides `<main id="main-content" tabIndex={-1}>`
          as the focus-return landmark; mirror it so the finalFocus resolver's
          `document.getElementById('main-content')` fallback resolves. */}
      <main id="main-content" tabIndex={-1} />
      <EscalationTaskQueue
        actorRole={actorRole}
        actorUserId="actor-1"
        overdueCount={0}
        // length 1 → the task-type filter Select stays hidden (no need to mock it).
        distinctTaskTypes={['manual_outreach_required']}
        items={[makeTask({ taskId: 't1' })]}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  doneCapture.finalFocus = undefined;
  doneCapture.onSubmit = undefined;
});

describe('<EscalationTaskQueue> row actions — Done + ⋯ overflow (UX-audit #4/#5a)', () => {
  it('renders Done as the single visible primary button', () => {
    renderQueue();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('moves Skip and Reassign into the ⋯ menu (not standalone buttons)', () => {
    renderQueue();
    expect(screen.getByRole('menuitem', { name: 'Skip' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reassign' })).toBeTruthy();
    // They are NOT top-level buttons anymore — only Done is.
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('opens the Done dialog with a finalFocus resolver', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const dialog = screen.getByTestId('done-dialog');
    expect(dialog.getAttribute('data-finalfocus-type')).toBe('function');
  });

  it('keeps a STABLE finalFocus that survives close-on-success and returns #main-content (regression: the prop must not evaporate to undefined at close)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderQueue();
      // Open the Done dialog — it receives the launching row's focus-return
      // resolver via the stable `stableFinalFocus` callback.
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(typeof doneCapture.finalFocus).toBe('function');
      expect(typeof doneCapture.onSubmit).toBe('function');

      // Simulate a Done SUCCESS. postAction raises `closedViaSuccessRef` and the
      // queue nulls `doneDialogTarget` in the SAME commit that closes the dialog.
      await act(async () => {
        await doneCapture.onSubmit?.(undefined);
      });

      // The row's Done route was POSTed (proves the success path ran).
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/renewals/tasks/t1/done',
        expect.objectContaining({ method: 'POST' }),
      );

      // CLOSE-TIME GUARD. Base UI reads `finalFocus` LIVE at close. With the bug
      // (`finalFocus={doneDialogTarget?.finalFocus}`) the prop is `undefined` on
      // the close render, so this reads 'undefined' and FAILS. The fix passes a
      // stable callback, so it is STILL a function after the dialog closes.
      expect(typeof doneCapture.finalFocus).toBe('function');

      // ...and invoking it (as Base UI does at close) returns the surviving
      // #main-content landmark — NOT the now-unmounting ⋯ trigger, NOT
      // null/<body> — because `closedViaSuccessRef` was raised before close.
      const mainContent = document.getElementById('main-content');
      expect(mainContent).not.toBeNull();
      const resolve = doneCapture.finalFocus as () => HTMLElement | null;
      expect(resolve()).toBe(mainContent);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the Skip dialog (from the menu) with a finalFocus resolver', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Skip' }));
    const dialog = screen.getByTestId('skip-dialog');
    expect(dialog.getAttribute('data-finalfocus-type')).toBe('function');
  });

  it('opens the Reassign dialog (from the menu) with a finalFocus resolver', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reassign' }));
    const dialog = screen.getByTestId('reassign-dialog');
    expect(dialog.getAttribute('data-finalfocus-type')).toBe('function');
  });

  it('renders no action controls for a read-only manager', () => {
    renderQueue('manager');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Skip' })).toBeNull();
  });

  it('forwards the trigger node to BOTH the Base UI ref and the row menu ref (mergeRefs regression guard)', () => {
    renderQueue();
    // The trigger wires `ref={mergeRefs(baseRef, rowMenuTriggerRef)}`. mergeRefs
    // forwards the DOM node to EACH ref, so Base UI's own ref (baseRefSpy) must
    // receive the trigger element. A regression to `ref={rowMenuTriggerRef}`
    // alone drops baseRef entirely → this spy is never called with a node, and
    // the menu would stop anchoring in production (the Base-UI ref-override
    // trap the mocked menu can't otherwise exercise).
    expect(baseRefSpy).toHaveBeenCalled();
    const receivedElement = baseRefSpy.mock.calls.some(
      ([node]) => node instanceof HTMLElement,
    );
    expect(receivedElement).toBe(true);
  });
});
