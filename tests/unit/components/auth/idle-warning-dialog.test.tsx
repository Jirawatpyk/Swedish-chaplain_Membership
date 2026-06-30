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
import { render, screen, act, cleanup } from '@testing-library/react';
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
