/**
 * `<EscalationTaskQueue>` filters — 122 US7b-2 (T731), boards
 * `Admin-renewal-tasks` (+`-mobile`) and `Admin-state-tasks-manager`.
 *
 * - The overdue toggle card, then a "Filter tasks" group holding Status (Open,
 *   Done, Skipped) and Assignment (All, Mine, Unassigned) as pressed-button
 *   groups, then the "Task type" select (AURA `Select`).
 * - A manager reads the board's note instead (an AURA alert).
 * - Every filter drives the URL with `router.replace(…, { scroll: false })`
 *   and drops a stale `cursor`.
 *
 * Rendered against the real `en.json`, so the copy asserted is what ships.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { buildFormats } from '@/i18n/formats';
import {
  EscalationTaskQueue,
  type EscalationTaskQueueItem,
} from '@/app/(staff)/admin/renewals/tasks/_components/escalation-task-queue';

const replace = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
}));

const T = enMessages.admin.renewals.tasks;

/** AURA Select keeps a real <select> under its listbox: pick by changing it (US5a precedent). */
function pickNative(label: string, value: string) {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  if (!native) throw new Error(`no native select for ${label}`);
  fireEvent.change(native, { target: { value } });
}

/** The value behind an option, read by its text (the "All types" value is the component's own). */
function optionValue(label: string, text: string): string {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  const found = [...(native?.options ?? [])].find((o) => o.textContent === text);
  if (!found) throw new Error(`no option ${text}`);
  return found.value;
}

function nativeOptions(label: string): string[] {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  return [...(native?.options ?? [])].map((o) => o.textContent ?? '');
}

function makeTask(
  overrides: Partial<EscalationTaskQueueItem> & { taskId: string; taskType: string },
): EscalationTaskQueueItem {
  return {
    memberId: `member-${overrides.taskId}`,
    memberCompanyName: 'Acme Co',
    memberTierBucket: null,
    cycleId: null,
    cycleExpiresAt: null,
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

function renderQueue(
  items: EscalationTaskQueueItem[],
  distinctTaskTypes: string[] = Array.from(new Set(items.map((i) => i.taskType))).sort(),
  overdueCount = 0,
  canMutate = true,
) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      formats={buildFormats('en')}
      timeZone="Asia/Bangkok"
    >
      <EscalationTaskQueue
        canMutate={canMutate}
        actorUserId="actor-1"
        overdueCount={overdueCount}
        distinctTaskTypes={distinctTaskTypes}
        items={items}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

const ONE = [makeTask({ taskId: 't1', taskType: 'phone_call' })];
const lastUrl = () => String(replace.mock.calls.at(-1)?.[0]);

describe('<EscalationTaskQueue> — status and assignment groups (board Admin-renewal-tasks)', () => {
  it('groups the filters as "Filter tasks"', () => {
    renderQueue(ONE);
    const filters = screen.getByRole('group', { name: 'Filter tasks' });
    expect(within(filters).getByRole('group', { name: 'Status' })).toBeInTheDocument();
    expect(within(filters).getByRole('group', { name: 'Assignment' })).toBeInTheDocument();
  });

  it('shows Status as pressed buttons, Open pressed by default', () => {
    renderQueue(ONE);
    const status = screen.getByRole('group', { name: 'Status' });
    const buttons = within(status).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Open', 'Done', 'Skipped']);
    expect(within(status).getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(status).getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'false');
    // The status tablist is gone with its tabpanel.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('draws both groups as AURA toggle chips, so the pressed one carries a check, not only a fill', () => {
    renderQueue(ONE);
    for (const name of ['Status', 'Assignment']) {
      for (const button of within(screen.getByRole('group', { name })).getAllByRole('button')) {
        expect(button).toHaveClass('aura-tag');
      }
    }
  });

  it('presses the status the URL carries', () => {
    searchParamsStub = new URLSearchParams('status=skipped');
    renderQueue(ONE);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getByRole('button', { name: 'Skipped' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a status press sets ?status= and drops a stale cursor, keeping the scroll', () => {
    searchParamsStub = new URLSearchParams('cursor=abc');
    renderQueue(ONE);
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Done' }));
    expect(lastUrl()).toBe('?status=done');
    expect(replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
  });

  it('shows Assignment as pressed buttons (All, Mine, Unassigned)', () => {
    renderQueue(ONE);
    const group = screen.getByRole('group', { name: 'Assignment' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Mine', 'Unassigned']);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: 'Mine' }));
    expect(lastUrl()).toBe('?assignment=mine');
  });

  it('a colleague tray in the URL presses none of the three (spec: the link keeps working)', () => {
    searchParamsStub = new URLSearchParams('assignment=7c3a1f2e-0000-4000-8000-000000000001');
    renderQueue(ONE);
    const group = screen.getByRole('group', { name: 'Assignment' });
    for (const name of ['All', 'Mine', 'Unassigned']) {
      expect(within(group).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('pressing All clears the assignment', () => {
    searchParamsStub = new URLSearchParams('assignment=mine');
    renderQueue(ONE);
    fireEvent.click(within(screen.getByRole('group', { name: 'Assignment' })).getByRole('button', { name: 'All' }));
    expect(lastUrl()).not.toContain('assignment');
  });
});

describe('<EscalationTaskQueue> — task type (AURA Select)', () => {
  it('is hidden when only one task type exists', () => {
    renderQueue(ONE, ['phone_call']);
    expect(screen.queryByRole('combobox', { name: 'Task type' })).toBeNull();
  });

  it('lists "All types" and each server-derived type, labelled "Task type"', () => {
    renderQueue(ONE, ['director_call', 'phone_call']);
    expect(screen.getByRole('combobox', { name: 'Task type' })).toHaveTextContent('All types');
    expect(nativeOptions('Task type')).toEqual(['All types', 'Director call', 'Phone call']);
  });

  it('shows "All types" as a chosen value, not in the grey of a placeholder (board)', () => {
    renderQueue(ONE, ['director_call', 'phone_call']);
    const shown = screen.getByRole('combobox', { name: 'Task type' }).querySelector('.aura-select__value');
    expect(shown).toHaveTextContent('All types');
    expect(shown).not.toHaveClass('is-placeholder');
  });

  it('sits at the end of the filter row from 640px, keeping its visible "Task type" label (board)', () => {
    renderQueue(ONE, ['director_call', 'phone_call']);
    const field = screen.getByRole('combobox', { name: 'Task type' }).closest('.aura-field')?.parentElement;
    expect(field).toHaveClass('sm:ms-auto');
    expect(screen.getByText('Task type', { selector: 'label' })).toBeVisible();
  });

  it('choosing a type sets ?task_type=, and "All types" clears it', () => {
    renderQueue(ONE, ['director_call', 'phone_call']);
    pickNative('Task type', 'director_call');
    expect(lastUrl()).toBe('?task_type=director_call');
    expect(replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
  });

  it('"All types" clears the param rather than setting it literally', () => {
    searchParamsStub = new URLSearchParams('task_type=phone_call');
    renderQueue(ONE, ['director_call', 'phone_call']);
    pickNative('Task type', optionValue('Task type', 'All types'));
    expect(lastUrl()).not.toContain('task_type');
  });
});

describe('<EscalationTaskQueue> — overdue toggle and the manager note', () => {
  const banner = () => screen.getByRole('button', { name: /show only overdue tasks/i });

  it('reads "N overdue tasks / Show only overdue tasks", not pressed by default', () => {
    renderQueue(ONE, undefined, 4);
    expect(banner()).toHaveAttribute('aria-pressed', 'false');
    expect(banner()).toHaveAccessibleName(/4 overdue tasks/i);
    expect(banner().textContent).not.toMatch(/click/i);
  });

  it('keeps its name and reports pressed while the filter is on, and toggles ?overdue_only=', () => {
    searchParamsStub = new URLSearchParams('overdue_only=true');
    renderQueue(ONE, undefined, 4);
    expect(banner()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(banner());
    expect(lastUrl()).not.toContain('overdue_only');
  });

  it('a manager sees the board note as an AURA alert; the toggle stays, since it only filters', () => {
    renderQueue(ONE, undefined, 4, false);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(T.manager_read_only_notice);
    expect(note.closest('.aura-alert')).not.toBeNull();
    expect(banner()).toBeInTheDocument();
  });

  // spec 122 US7b-2 — the toggle used to unmount once pressed (the count it
  // was gated on could drop to 0 under the filter), dropping focus to <body>
  // and leaving browser Back as the only way to clear the filter.
  it('stays mounted and pressed while the filter is on, even when the count is 0', () => {
    searchParamsStub = new URLSearchParams('overdue_only=true');
    renderQueue(ONE, undefined, 0);
    expect(banner()).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps focus on the toggle once pressed, and pressing again clears ?overdue_only', () => {
    const view = renderQueue(ONE, undefined, 3);
    const button = banner();
    button.focus();
    fireEvent.click(button);
    expect(String(replace.mock.calls.at(-1)?.[0])).toContain('overdue_only=true');

    // The router applies the new URL; the server re-renders with the filter
    // on (the last overdue task may have just been resolved, so count 0).
    searchParamsStub = new URLSearchParams('overdue_only=true');
    view.rerender(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages}
        formats={buildFormats('en')}
        timeZone="Asia/Bangkok"
      >
        <EscalationTaskQueue
          canMutate
          actorUserId="actor-1"
          overdueCount={0}
          distinctTaskTypes={['phone_call']}
          items={ONE}
        />
      </NextIntlClientProvider>,
    );
    expect(banner()).toBe(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(button);

    fireEvent.click(banner());
    expect(String(replace.mock.calls.at(-1)?.[0])).not.toContain('overdue_only');
  });

  it('is not rendered outside the Open tab, even with ?overdue_only=true', () => {
    searchParamsStub = new URLSearchParams('status=done&overdue_only=true');
    renderQueue(ONE, undefined, 3);
    expect(
      screen.queryByRole('button', { name: /show only overdue tasks/i }),
    ).toBeNull();
  });
});

describe('<EscalationTaskQueue> — dates', () => {
  it('renders the due date day-first (en-GB)', () => {
    renderQueue(ONE);
    expect(screen.getAllByText('10 Apr 2026').length).toBeGreaterThan(0);
  });

});
