/**
 * F9 — `InsightsPanel` optimistic-dismiss behaviour.
 *
 * Clicking a per-insight dismiss control must remove the insight from the panel
 * IMMEDIATELY (before the POST resolves) so the dashboard doesn't appear frozen
 * during the ~2-5s server re-render that `router.refresh()` triggers. A FAILED
 * POST rolls the insight back into view + surfaces the error toast.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { InsightsPanel, type InsightLine } from '@/components/dashboard/insights-panel';

const LINES: readonly InsightLine[] = [
  { key: 'at_risk_followup', text: '5 at-risk members need follow-up' },
  { key: 'unused_eblast_quota', text: '50 members have unused E-Blast quota' },
];

const PANEL_PROPS = {
  title: 'Smart insights',
  emptyLabel: 'All clear.',
  dismissLabel: 'Dismiss insight',
  dismissedLabel: 'Insight dismissed',
  dismissErrorLabel: 'Could not dismiss insight',
};

const DISMISS_50 = 'Dismiss insight: 50 members have unused E-Blast quota';

beforeEach(() => {
  vi.clearAllMocks();
  // The global setup runs on fake timers; the dismiss flow resolves a fetch +
  // re-renders from an async continuation, which React schedules via a timer.
  // Real timers let that settle (the optimistic hide is synchronous either way).
  vi.useRealTimers();
});

describe('InsightsPanel — optimistic dismiss', () => {
  it('removes the insight immediately on click, before the POST resolves', () => {
    // fetch never resolves → proves the removal is OPTIMISTIC, not awaiting the POST.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<InsightsPanel {...PANEL_PROPS} lines={LINES} />);
    expect(
      screen.getByText('50 members have unused E-Blast quota'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: DISMISS_50 }));

    // Gone immediately while the POST is still pending; sibling insight stays.
    expect(
      screen.queryByText('50 members have unused E-Blast quota'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('5 at-risk members need follow-up'),
    ).toBeInTheDocument();
  });

  it('rolls the insight back + toasts error when the POST fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    render(<InsightsPanel {...PANEL_PROPS} lines={LINES} />);

    fireEvent.click(screen.getByRole('button', { name: DISMISS_50 }));
    // optimistically gone
    expect(
      screen.queryByText('50 members have unused E-Blast quota'),
    ).not.toBeInTheDocument();

    // rolled back into view once the POST rejects
    await waitFor(() => {
      expect(
        screen.getByText('50 members have unused E-Blast quota'),
      ).toBeInTheDocument();
    });
    expect(toastError).toHaveBeenCalledWith('Could not dismiss insight');
  });

  it('keeps the insight removed + toasts success + reconciles on a 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    render(<InsightsPanel {...PANEL_PROPS} lines={LINES} />);

    fireEvent.click(screen.getByRole('button', { name: DISMISS_50 }));
    // optimistically gone
    expect(
      screen.queryByText('50 members have unused E-Blast quota'),
    ).not.toBeInTheDocument();

    // success path: reconcile with the server (the suppressed insight will drop
    // from the freshly-computed `lines` on the next render).
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith('Insight dismissed');
    expect(toastError).not.toHaveBeenCalled();
    // stays gone — no rollback on success.
    expect(
      screen.queryByText('50 members have unused E-Blast quota'),
    ).not.toBeInTheDocument();
  });
});

describe('InsightsPanel — on AURA (spec 122 US11)', () => {
  it('is an AURA card titled at h2, with each dismiss an AURA icon button', () => {
    const { container } = render(<InsightsPanel {...PANEL_PROPS} lines={LINES} />);
    const card = container.querySelector('section.aura-card');
    expect(card).not.toBeNull();
    expect(card!.querySelector('h2.aura-card__title')).toHaveTextContent('Smart insights');
    const dismiss = screen.getByRole('button', { name: DISMISS_50 });
    expect(dismiss).toHaveClass('aura-icon-btn', 'aura-icon-btn--touch');
  });

  it('keeps the empty state as a status line', () => {
    render(<InsightsPanel {...PANEL_PROPS} lines={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('All clear.');
  });

  it('draws the rows between dividers, each with a decorative dot, as Needs attention does', () => {
    render(<InsightsPanel {...PANEL_PROPS} lines={LINES} />);
    const list = screen.getByRole('list');
    expect(list.className).toContain('divide-y');
    const rows = screen.getAllByRole('listitem');
    for (const row of rows) {
      expect(row.querySelectorAll('[data-slot="insight-dot"][aria-hidden="true"]')).toHaveLength(1);
      expect(row.className).toContain('min-h-11');
    }
  });
});

describe('InsightsPanel — keyboard focus after a dismiss (WCAG 2.4.3)', () => {
  const THREE: readonly InsightLine[] = [
    ...LINES,
    { key: 'underused_event_tickets', text: '12 members have under-used event tickets' },
  ];
  const name = (text: string) => ({ name: `Dismiss insight: ${text}` });

  beforeEach(() => {
    // The POST never resolves: focus is decided by the optimistic hide alone.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  });

  it('moves focus to the next insight’s dismiss button', () => {
    render(<InsightsPanel {...PANEL_PROPS} lines={THREE} />);
    const middle = screen.getByRole('button', name('50 members have unused E-Blast quota'));
    middle.focus();
    fireEvent.click(middle);
    expect(document.activeElement).toBe(
      screen.getByRole('button', name('12 members have under-used event tickets')),
    );
  });

  it('moves focus to the previous one when the last insight is dismissed', () => {
    render(<InsightsPanel {...PANEL_PROPS} lines={THREE} />);
    const last = screen.getByRole('button', name('12 members have under-used event tickets'));
    last.focus();
    fireEvent.click(last);
    expect(document.activeElement).toBe(
      screen.getByRole('button', name('50 members have unused E-Blast quota')),
    );
  });

  it('moves focus to the panel title when the only insight is dismissed', () => {
    render(<InsightsPanel {...PANEL_PROPS} lines={[LINES[0]!]} />);
    const only = screen.getByRole('button', name('5 at-risk members need follow-up'));
    only.focus();
    fireEvent.click(only);
    const title = screen.getByRole('heading', { level: 2, name: 'Smart insights' });
    expect(document.activeElement).toBe(title);
    expect(title).toHaveAttribute('tabindex', '-1');
  });

  it('returns focus to the restored insight’s dismiss button when the POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    render(<InsightsPanel {...PANEL_PROPS} lines={THREE} />);
    const middle = screen.getByRole('button', name('50 members have unused E-Blast quota'));
    middle.focus();
    fireEvent.click(middle);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', name('50 members have unused E-Blast quota')),
      );
    });
  });

  it('leaves focus alone on a failed POST once the user has moved it elsewhere', async () => {
    let fail!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { fail = () => resolve(new Response(null, { status: 500 })); })),
    );
    render(
      <>
        <button type="button">Elsewhere</button>
        <InsightsPanel {...PANEL_PROPS} lines={THREE} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', name('50 members have unused E-Blast quota')));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fail();
    await waitFor(() => {
      expect(screen.getByRole('button', name('50 members have unused E-Blast quota'))).toBeInTheDocument();
    });
    expect(document.activeElement).toBe(elsewhere);
  });
});
