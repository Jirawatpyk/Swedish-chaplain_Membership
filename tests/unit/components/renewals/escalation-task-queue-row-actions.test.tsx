/**
 * `<EscalationTaskQueue>` table and row actions — 122 US7b-2 (T732), boards
 * `Admin-renewal-tasks` (+`-mobile`).
 *
 * - One AURA DataTable that stacks into cards below 640px; the actions column
 *   exists only for someone who can act.
 * - Each row: "Done" (secondary) plus a ⋯ menu (Skip, Reassign, View timeline)
 *   named "Skip, reassign or view timeline — {type}, {member}".
 * - The member cell holds one link (the timeline link moved into the menu).
 * - Done / Skip / Reassign open their dialogs with one stable focus-return
 *   resolver: after a success it lands on #main-content (the row unmounts on
 *   refresh); on Cancel it returns to the control that opened the dialog.
 *
 * The three dialog modules are replaced by markers that record the props they
 * receive, so these tests read this component's wiring only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
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

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

type FinalFocus = () => HTMLElement | null;
interface Capture {
  open: boolean;
  finalFocus?: FinalFocus | undefined;
  onSubmit?: ((value: never) => Promise<void>) | undefined;
}
const { cap } = vi.hoisted(() => ({
  cap: {
    done: { open: false } as Capture,
    skip: { open: false } as Capture,
    reassign: { open: false } as Capture,
  },
}));

function marker(name: 'done' | 'skip' | 'reassign') {
  return function DialogMarker(props: { open: boolean; finalFocus?: FinalFocus; onSubmit?: (v: never) => Promise<void> }) {
    // Recorded on every render, the closing one too, so a resolver that
    // evaporates when the dialog closes is caught.
    cap[name].open = props.open;
    cap[name].finalFocus = props.finalFocus;
    cap[name].onSubmit = props.onSubmit;
    return props.open ? <div data-testid={`${name}-dialog`} /> : null;
  };
}

vi.mock('@/app/(staff)/admin/renewals/tasks/_components/done-task-dialog', () => ({
  DoneTaskDialog: marker('done'),
}));
vi.mock('@/app/(staff)/admin/renewals/tasks/_components/skip-task-dialog', () => ({
  SkipTaskDialog: marker('skip'),
}));
vi.mock('@/app/(staff)/admin/renewals/tasks/_components/reassign-task-dropdown', () => ({
  ReassignTaskDropdown: marker('reassign'),
}));

const T = enMessages.admin.renewals.tasks;

function makeTask(overrides: Partial<EscalationTaskQueueItem> & { taskId: string }): EscalationTaskQueueItem {
  return {
    memberId: `member-${overrides.taskId}`,
    memberCompanyName: 'Acme Co',
    memberTierBucket: 'premium',
    cycleId: null,
    cycleExpiresAt: '2026-09-30T00:00:00.000Z',
    taskType: 'phone_call',
    assignedToRole: 'admin',
    assignedToUserId: 'u-1',
    assignedToDisplayName: 'Karin Ek',
    assignedToEmail: 'karin@example.com',
    dueAt: '2026-04-10T00:00:00.000Z',
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
    yearInCycle: 1,
    totalYears: 1,
    ...overrides,
  };
}

function renderQueue(canMutate = true, items = [makeTask({ taskId: 't1' })]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} formats={buildFormats('en')} timeZone="Asia/Bangkok">
      <main id="main-content" tabIndex={-1} />
      <EscalationTaskQueue
        canMutate={canMutate}
        actorUserId="actor-1"
        overdueCount={0}
        distinctTaskTypes={['phone_call']}
        items={items}
      />
    </NextIntlClientProvider>,
  );
}

const MENU = 'Skip, reassign or view timeline — Phone call, Acme Co';
/** The row's Done button (the Status filter has a "Done" button too). */
function rowDone(): HTMLElement {
  return within(screen.getByRole('grid')).getByRole('button', { name: 'Done' });
}
function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: MENU }));
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useRealTimers();
  for (const c of Object.values(cap)) {
    c.open = false;
    delete c.finalFocus;
    delete c.onSubmit;
  }
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('<EscalationTaskQueue> table (AURA DataTable)', () => {
  it('renders an AURA DataTable named "Escalation tasks" that stacks below 640px', () => {
    renderQueue();
    const grid = screen.getByRole('grid', { name: T.table_caption });
    expect(grid.closest('.aura-table')).not.toBeNull();
  });

  it('shows the board columns, with Actions only for someone who can act', () => {
    renderQueue();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Member',
      'Tier',
      'Expiry',
      'Task type',
      'Due',
      'Assigned to',
      'Status',
      expect.any(String),
    ]);
  });

  it('a manager gets no actions column and no row controls', () => {
    renderQueue(false);
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(within(screen.getByRole('grid')).queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('button', { name: MENU })).toBeNull();
  });

  it('the member cell holds one link, to the member', () => {
    renderQueue();
    const cell = screen.getByRole('link', { name: 'Acme Co' }).closest('[role="gridcell"]') as HTMLElement;
    expect(within(cell).getAllByRole('link')).toHaveLength(1);
    expect(within(cell).getByRole('link')).toHaveAttribute('href', '/admin/members/member-t1');
  });

  it('shows the tier badge, the assignee name over the role, and the status pill', () => {
    renderQueue();
    // In its column, and again beside the task type on a phone card.
    expect(screen.getAllByText(enMessages.admin.renewals.tierBadge.premium)[0]?.closest('.aura-badge')).not.toBeNull();
    expect(screen.getByText('Karin Ek')).toBeInTheDocument();
    expect(screen.getByText(T.assigneeRole.admin)).toBeInTheDocument();
    expect(screen.getByText(T.status.open, { selector: '.aura-pill *, .aura-pill' })).toBeInTheDocument();
  });

  it('marks a task more than three days late with a danger "Overdue" badge', () => {
    renderQueue(true, [makeTask({ taskId: 't1', dueAt: '2020-01-01T00:00:00.000Z' })]);
    expect(screen.getByText(T.overdue_badge).closest('.aura-badge')).toHaveClass('aura-badge--danger');
  });
});

describe('<EscalationTaskQueue> row actions — Done + ⋯ menu', () => {
  it('Done is the row\'s secondary button', () => {
    renderQueue();
    expect(rowDone()).toHaveClass('aura-btn--secondary');
  });

  it('the ⋯ menu holds Skip, Reassign and View timeline, none of them standalone', () => {
    renderQueue();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reassign' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'View timeline' })).toBeInTheDocument();
  });

  it('View timeline is a link item to the member timeline', () => {
    renderQueue();
    openMenu();
    const item = screen.getByRole('menuitem', { name: 'View timeline' });
    expect(item.closest('a') ?? item).toHaveAttribute('href', '/admin/members/member-t1/timeline');
  });

  it('Done opens its dialog; a success POSTs the same route and body, and focus lands on #main-content', async () => {
    renderQueue();
    fireEvent.click(rowDone());
    expect(screen.getByTestId('done-dialog')).toBeInTheDocument();
    expect(typeof cap.done.finalFocus).toBe('function');
    await act(async () => {
      await (cap.done.onSubmit as unknown as (n: string | undefined) => Promise<void>)('Called, renewing');
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/renewals/tasks/t1/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome_note: 'Called, renewing' }),
    });
    // The resolver survives the close and steers off the vanishing row.
    expect(cap.done.open).toBe(false);
    expect(cap.done.finalFocus?.()).toBe(document.getElementById('main-content'));
  });

  it('a cancelled Done returns focus to the Done button', () => {
    renderQueue();
    const done = rowDone();
    fireEvent.click(done);
    expect(cap.done.finalFocus?.()).toBe(done);
  });

  it('Skip from the menu returns focus to that row\'s ⋯ button and posts {skipped_reason}', async () => {
    renderQueue();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Skip' }));
    expect(screen.getByTestId('skip-dialog')).toBeInTheDocument();
    expect(cap.skip.finalFocus?.()).toBe(screen.getByRole('button', { name: MENU }));
    await act(async () => {
      await (cap.skip.onSubmit as unknown as (r: string) => Promise<void>)('Unreachable');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/renewals/tasks/t1/skip',
      expect.objectContaining({ body: JSON.stringify({ skipped_reason: 'Unreachable' }) }),
    );
  });

  it('Reassign from the menu posts {to_user_id}', async () => {
    renderQueue();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reassign' }));
    expect(screen.getByTestId('reassign-dialog')).toBeInTheDocument();
    await act(async () => {
      await (cap.reassign.onSubmit as unknown as (u: string) => Promise<void>)('u-2');
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/renewals/tasks/t1/reassign',
      expect.objectContaining({ body: JSON.stringify({ to_user_id: 'u-2' }) }),
    );
  });

  it('a closed task disables Done and the menu', () => {
    renderQueue(true, [makeTask({ taskId: 't1', status: 'done' })]);
    expect(rowDone()).toBeDisabled();
    expect(screen.getByRole('button', { name: MENU })).toBeDisabled();
  });
});

describe('<EscalationTaskQueue> empty states', () => {
  it('an empty open queue offers the history', () => {
    renderQueue(true, []);
    expect(screen.getByText(T.empty_state.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.empty_state.cta_history })).toBeInTheDocument();
  });
});
