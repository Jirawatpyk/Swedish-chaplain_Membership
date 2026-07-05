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

  it('BUG-018: "Stay signed in" does NOT sign the user out when the heartbeat POST fails transiently (5xx/429) — the session is still valid', async () => {
    // Pre-fix, stayAction force-signed-out on ANY non-OK heartbeat, so a
    // transient 500 (Neon/Upstash blip) or a 429 (heartbeat rate limit)
    // ejected a user whose session was perfectly alive. Now only a 401
    // (no-session) does. Heartbeat returns 500 here.
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
    // Dialog closed (the user stayed signed in) and NO involuntary-signout
    // toast fired — the transient failure was swallowed, not escalated.
    expect(screen.queryByText('Are you still here?')).toBeNull();
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
    // prevent a delayed sign-out. (The synchronous keepAliveRef guard is
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
    // Regression for the code-review round-2 finding: resetting the idle clock
    // only AFTER the heartbeat resolved let a >5 s cold-start heartbeat leave
    // the clock stale, so the 5 s poll re-opened the warning mid-flight and its
    // fresh countdown signed out a user whose session was being extended. The
    // fix resets OPTIMISTICALLY before the await.
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
    // Advance past the 5 s poll while the heartbeat is STILL pending: the
    // optimistic reset must keep the warning closed (no spurious re-open).
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

  it('#5: a failed "Stay" heartbeat (5xx) rolls the idle clock back so the warning re-appears (no silent 29-min suppression)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    renderDialog();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000 + 5_000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Stay signed in'));
    });
    // Closed optimistically…
    expect(screen.queryByText('Are you still here?')).toBeNull();
    // …but the 500 rolled the idle clock back to its stale pre-click value, so
    // the next poll tick (≤5 s) re-opens the warning to prompt a retry — rather
    // than falsely suppressing it for ~29 min while the session lapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText('Are you still here?')).not.toBeNull();
    // The transient failure was NOT escalated to an involuntary sign-out.
    expect(toast.info).not.toHaveBeenCalled();
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
