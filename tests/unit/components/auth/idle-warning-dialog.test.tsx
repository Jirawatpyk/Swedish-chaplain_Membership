/**
 * Unit tests for <IdleWarningDialog> — covers F5 amendment (G3)
 * adding `swecham:pause-idle-timer` / `swecham:resume-idle-timer`
 * listeners so Stripe payment flows don't trigger involuntary sign-out
 * mid-payment (FR-028c).
 *
 * Two new cases:
 *   - Pause event freezes the timer: 29 min of frozen time does NOT
 *     open the warning modal.
 *   - Resume event preserves elapsed-before-pause: after `pause`,
 *     `resume`, and 29 min total post-resume active time, the modal
 *     opens as expected.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));
import { toast } from 'sonner';

// Mock the auth domain module — importing the real one would drag in
// Node-only infrastructure (argon2, postgres-js). We only need the
// constant.
vi.mock('@/modules/auth/domain/session', () => ({
  IDLE_TIMEOUT_MS: 30 * 60 * 1000,
}));

vi.mock('@/lib/portal-paths', () => ({
  portalSignInPath: () => '/sign-in',
}));

import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';

const messages = {
  auth: {
    idleWarning: {
      title: 'Are you still here?',
      description: 'Signing out in {seconds} s',
      stay: 'Stay signed in',
      signOut: 'Sign out',
      signedOutInactive:
        'You were signed out due to inactivity. Please sign in again.',
    },
  },
};

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <IdleWarningDialog portal="member" />
    </NextIntlClientProvider>,
  );
}

describe('<IdleWarningDialog> — F5 pause/resume amendment', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('pauseIdleTimer event freezes the 29-min clock — warning does NOT show after 29 min of frozen time', async () => {
    renderDialog();
    // Dispatch pause.
    act(() => {
      window.dispatchEvent(new CustomEvent('swecham:pause-idle-timer'));
    });
    // Advance 29 min of wall-clock time. Because we're paused, the
    // poll's freeze guard suppresses the warning.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
  });

  it('on countdown expiry, the involuntary-signout toast states the inactivity reason (not the countdown copy) — TC-AUTH-05 step 3', async () => {
    // Resolve the sign-out POST immediately so forceSignOut proceeds to the
    // toast under fake timers (a real fetch would never settle here).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    renderDialog();
    // Open the warning instantly via the test hook instead of idling 29 min.
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    // Run the 60-second countdown to zero → involuntary sign-out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(toast.info).toHaveBeenCalledWith(
      'You were signed out due to inactivity. Please sign in again.',
    );
    // Exactly one toast with that message — catches an accidental extra/wrong
    // toast.info (e.g. someone re-routing the countdown copy through a toast).
    expect(toast.info).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('BUG-018: a transient 5xx/429 heartbeat re-warns (re-opens) but does NOT immediately sign the user out', async () => {
    // Pre-fix, stayAction force-signed-out on ANY non-OK heartbeat. Now a
    // transient 500 (Neon/Upstash blip) or 429 (heartbeat rate limit) does NOT
    // sign the user out — it re-opens the warning so they can retry Stay; only
    // an ignored 60 s countdown (or a definitive 401) signs them out.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    renderDialog();
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    // The heartbeat failed → the warning re-opened to prompt a retry, but NO
    // involuntary-signout toast fired (that needs the countdown or a 401).
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('BUG-018: "Stay signed in" signs out only on a definitive 401 (session genuinely gone)', async () => {
    // First fetch = heartbeat → 401; second = the forceSignOut sign-out POST.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    // A real no-session 401 DOES escalate to involuntary sign-out with the
    // inactivity toast (not the countdown copy).
    expect(toast.info).toHaveBeenCalledWith(
      'You were signed out due to inactivity. Please sign in again.',
    );
    vi.unstubAllGlobals();
  });

  it('BUG-018: after "Stay signed in" succeeds, a still-pending countdown can NOT later force sign-out', async () => {
    // Regression guard for the stay-success path (previously uncovered). Open
    // the warning, click Stay (heartbeat ok), then advance well past the old
    // 60 s countdown: the dialog must stay closed and NO involuntary-signout
    // toast may fire. This proves the OPTIMISTIC close + interval teardown
    // prevent a delayed sign-out. (The synchronous stayPendingRef guard is
    // additional real-browser defense-in-depth for the effect-flush race that
    // JSDOM + act() cannot reproduce, so it is not directly asserted here.)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    renderDialog();
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 1000);
    });
    expect(toast.info).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('#3: a slow but successful "Stay" heartbeat does NOT let the idle poll re-open + sign out', async () => {
    // Regression for the code-review round-2 finding: a >5 s cold-start
    // heartbeat left the clock stale, so the 5 s poll re-opened the warning
    // mid-flight and its fresh countdown signed out a user whose session was
    // being extended. The fix: `stayPendingRef` suppresses the poll re-open
    // while the heartbeat is in flight (no optimistic clock reset).
    let resolveHeartbeat: (v: unknown) => void = () => {};
    const heartbeat = new Promise((r) => {
      resolveHeartbeat = r;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(heartbeat));
    renderDialog();
    // Idle past the 29-min threshold so the warning opens naturally (the idle
    // clock is genuinely stale at click time).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000 + 5_000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    // Click Stay — the heartbeat is still pending (slow cold start).
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // Advance past the 5 s poll while the heartbeat is STILL pending:
    // stayPendingRef must keep the poll from re-opening the warning.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // Heartbeat finally returns 200 → still closed, and no involuntary signout.
    await act(async () => {
      resolveHeartbeat({ ok: true, status: 200 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(screen.queryByText('Are you still here?')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('#190: a failed "Stay" heartbeat re-warns even after the user moves the mouse (clock-independent re-open)', async () => {
    // A failed heartbeat must re-open the warning DIRECTLY — not by staling the
    // idle clock, which the activity tracker would immediately reset on the next
    // mouse move (client activity does not extend the SERVER session).
    let resolveHeartbeat: (v: unknown) => void = () => {};
    const heartbeat = new Promise((r) => {
      resolveHeartbeat = r;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(heartbeat));
    renderDialog();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000 + 5_000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    // Click Stay → optimistic close; heartbeat pending.
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // The user keeps working — a mousemove now (open===false, tracker armed)
    // resets the idle clock fresh; a clock-driven re-warn would be suppressed.
    await act(async () => {
      window.dispatchEvent(new Event('mousemove'));
    });
    // Heartbeat fails (500) → the warning re-opens DIRECTLY despite the fresh
    // clock, and no involuntary sign-out fired.
    await act(async () => {
      resolveHeartbeat({ ok: false, status: 500 });
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('#194: a hung "Stay" heartbeat aborts at the timeout and re-warns (never suppresses forever)', async () => {
    // A fetch that only ends via the AbortController timeout.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            (opts?.signal as AbortSignal | undefined)?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    renderDialog();
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    // Optimistically closed; heartbeat hung; poll suppressed by stayPendingRef.
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // Advance past HEARTBEAT_TIMEOUT_MS (10 s) → controller.abort() → catch →
    // the warning re-opens (the flag does not suppress it indefinitely).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it('#143: a second "Stay" click while a heartbeat is in flight is ignored (single fetch)', async () => {
    let resolveHeartbeat: (v: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveHeartbeat = r;
        }),
      )
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    act(() => {
      window.dispatchEvent(new Event('swecham:open-idle-warning'));
    });
    // Two clicks before the optimistic close unmounts the button: the in-flight
    // guard must ignore the second so only ONE heartbeat fires.
    await act(async () => {
      const btn = screen.getByText('Stay signed in');
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    await act(async () => {
      resolveHeartbeat({ ok: true, status: 200 });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('resumeIdleTimer event thaws the clock — subsequent 29 min of activity re-shows the warning', async () => {
    renderDialog();
    act(() => {
      window.dispatchEvent(new CustomEvent('swecham:pause-idle-timer'));
    });
    // Freeze for 10 min of wall-clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });
    // Resume — the 10 min frozen offset should be applied to
    // lastActivityRef, so from here we need another 29 min before the
    // poll triggers.
    act(() => {
      window.dispatchEvent(new CustomEvent('swecham:resume-idle-timer'));
    });
    // 28 min of post-resume wall-clock → still below threshold.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(28 * 60 * 1000);
    });
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // 2 more minutes crosses the 29-min threshold → poll (5 s) fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
  });
});
