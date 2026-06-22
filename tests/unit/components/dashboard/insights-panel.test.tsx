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
vi.mock('sonner', () => ({
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
});
