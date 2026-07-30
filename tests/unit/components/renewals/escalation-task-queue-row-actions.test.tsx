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
import { render, screen, fireEvent } from '@testing-library/react';
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

// R3 — a spy standing in for Base UI's OWN trigger ref (arrives inside the
// render-prop `props` in React 19). The component must forward the DOM node to
// it via `mergeRefs(baseRef, rowMenuTriggerRef)`; a regression to
// `ref={rowMenuTriggerRef}` alone (the Base-UI ref-override trap that stops the
// menu from opening) would never call this spy. Hoisted so the vi.mock factory
// below can close over it.
const { baseRefSpy } = vi.hoisted(() => ({ baseRefSpy: vi.fn() }));

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
      }: {
        open: boolean;
        finalFocus?: unknown;
      }) =>
        open
          ? React.createElement('div', {
              'data-testid': 'done-dialog',
              'data-finalfocus-type': typeof finalFocus,
            })
          : null,
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
