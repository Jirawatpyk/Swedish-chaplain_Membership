/**
 * `<EscalationTaskQueue>` task-type filter — shadcn `Select` migration.
 *
 * The task-type filter used to be a raw native `<select>`, inconsistent
 * with the rest of the app's shadcn `Select` filters. This pins the
 * replacement: the trigger renders through `@/components/ui/select`
 * (mirroring `../../_components/tier-filter-select.tsx`'s `ALL='all'`
 * sentinel + `aria-labelledby` pattern), the `distinctTaskTypes.length > 1`
 * gate is preserved, and choosing a type still drives the `?task_type=`
 * URL param via the existing `setSearchParam` helper.
 *
 * jsdom cannot drive Base UI's pointer-based Select popup (same
 * precedent as `tests/unit/renewals/components/renewal-confirm-flow.test.tsx`
 * and `tests/unit/app/invoices/invoice-filters-popover.test.tsx`). The
 * mock below wires `value`/`onValueChange` through a React context so a
 * click on a `role="option"` genuinely fires `onValueChange`, and
 * `TranslatedSelectValue` renders the translated label for the current
 * value — options render eagerly (no portal) so they're always
 * queryable. Rendered against the real `en.json` (project convention)
 * so the copy asserted here is what ships.
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

const replace = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
}));

vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const SelectCtx = React.createContext<{
    value: string;
    onValueChange: (v: string) => void;
  }>({ value: '', onValueChange: () => {} });
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: ReactNode;
    }) =>
      React.createElement(
        SelectCtx.Provider,
        { value: { value, onValueChange } },
        children,
      ),
    SelectTrigger: ({
      children,
      ...rest
    }: { children: ReactNode } & Record<string, unknown>) =>
      React.createElement(
        'button',
        { type: 'button', role: 'combobox', ...rest },
        children,
      ),
    SelectContent: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => {
      const { onValueChange } = React.useContext(SelectCtx);
      return React.createElement(
        'div',
        { role: 'option', tabIndex: 0, onClick: () => onValueChange(value) },
        children,
      );
    },
    TranslatedSelectValue: ({
      translate,
    }: {
      translate: (v: string) => ReactNode;
    }) => {
      const { value } = React.useContext(SelectCtx);
      return React.createElement('span', null, translate(value));
    },
  };
});

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
  // UX-audit PR-A #2 — `distinctTaskTypes` is now a required prop, server-
  // derived over the whole tenant. Defaults here to the set derived from the
  // rendered items (ascending) so the pre-existing assertions keep holding;
  // pass it explicitly to prove the control is DECOUPLED from the page.
  distinctTaskTypes: string[] = Array.from(
    new Set(items.map((i) => i.taskType)),
  ).sort(),
) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      formats={buildFormats('en')}
      timeZone="Asia/Bangkok"
    >
      <EscalationTaskQueue
        actorRole="admin"
        actorUserId="actor-1"
        overdueCount={0}
        distinctTaskTypes={distinctTaskTypes}
        items={items}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<EscalationTaskQueue> — task-type filter (shadcn Select)', () => {
  it('does not render the filter when only one distinct task type is present (preserved gate)', () => {
    renderQueue([
      makeTask({ taskId: 't1', taskType: 'phone_call' }),
      makeTask({ taskId: 't2', taskType: 'phone_call' }),
    ]);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('derives the control from the server distinctTaskTypes prop, not the fetched page (UX-audit #2)', () => {
    // The fetched page holds only ONE type, but the tenant has TWO — the
    // control must still render, with BOTH options, because it now keys on
    // the server-derived list rather than what this 50-row page happened to
    // contain. This is the core decoupling #2 fixes.
    renderQueue(
      [makeTask({ taskId: 't1', taskType: 'phone_call' })],
      ['director_call', 'phone_call'],
    );
    expect(
      screen.getByRole('combobox', { name: 'Filter by task type' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All types',
      'Director call',
      'Phone call',
    ]);
  });

  it('renders the shadcn Select trigger defaulting to "All types" when ≥2 distinct types exist', () => {
    renderQueue([
      makeTask({ taskId: 't1', taskType: 'phone_call' }),
      makeTask({ taskId: 't2', taskType: 'director_call' }),
    ]);
    const trigger = screen.getByRole('combobox', {
      name: 'Filter by task type',
    });
    expect(trigger).toHaveTextContent('All types');
  });

  it('lists "All types" + one option per distinct task type, translated via resolveTaskTypeLabel', () => {
    renderQueue([
      makeTask({ taskId: 't1', taskType: 'phone_call' }),
      makeTask({ taskId: 't2', taskType: 'director_call' }),
    ]);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'All types',
      'Director call',
      'Phone call',
    ]);
  });

  it('choosing a task type sets ?task_type=<value> via the existing setSearchParam helper', () => {
    renderQueue([
      makeTask({ taskId: 't1', taskType: 'phone_call' }),
      makeTask({ taskId: 't2', taskType: 'director_call' }),
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Director call' }));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(String(replace.mock.calls[0]?.[0])).toBe('?task_type=director_call');
  });

  it('choosing "All types" (the ALL sentinel) clears the task_type param, not sets it literally', () => {
    searchParamsStub = new URLSearchParams('task_type=phone_call');
    renderQueue([
      makeTask({ taskId: 't1', taskType: 'phone_call' }),
      makeTask({ taskId: 't2', taskType: 'director_call' }),
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'All types' }));

    expect(replace).toHaveBeenCalledTimes(1);
    const url = String(replace.mock.calls[0]?.[0]);
    expect(url).not.toContain('task_type');
    expect(url).not.toContain('all');
  });
});
