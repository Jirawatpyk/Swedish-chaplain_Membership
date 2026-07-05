'use client';

/**
 * IdleWarningDialog (T163, docs/ux-standards.md § 8.2, spec FR-022, SC-013).
 *
 * Why this exists: surprising auto-sign-outs are the #1 UX complaint on
 * enterprise apps. Users with long-form input mid-compose can lose all
 * their work if the 30-minute idle cap hits silently. We give them a
 * 60-second heads-up with an explicit "Stay signed in" button.
 *
 * Behaviour (tied to the domain `IDLE_TIMEOUT_MS = 30 min`):
 *   - Fires at **29 minutes** of inactivity (IDLE_TIMEOUT_MS - 1 min).
 *   - Modal shows a live countdown from 60 → 0.
 *   - "Stay signed in" → POST /api/auth/heartbeat → resets local clock.
 *   - "Sign out now" → POST /api/auth/sign-out.
 *   - Countdown reaches 0 with no action → client-side POST to sign-out
 *     and redirect to the appropriate sign-in page with a friendly
 *     "signed out due to inactivity" toast.
 *
 * Inactivity is measured at the window level: any `mousemove`, `keydown`,
 * `click`, `scroll`, or `touchstart` resets the timer. We intentionally
 * do NOT listen to `visibilitychange` — a user who tabbed away for
 * 29 minutes IS idle per the spec.
 *
 * The heartbeat POST only extends the idle clock; the absolute 12-hour
 * cap is enforced server-side. If we're within ≤ 1 minute of the
 * absolute cap, "Stay signed in" will appear to work but the next
 * protected request will still fail with `no-session`. That's acceptable
 * — the error boundary will catch it and route through sign-in.
 *
 * Reduced motion: the `AlertDialog` primitive already honours
 * `prefers-reduced-motion` via Base UI animations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
// Client component — cannot import from the `@/modules/auth`
// barrel because the barrel transitively pulls in Application
// use-case composition roots which load Node-only Infrastructure
// modules (argon2, postgres-js, etc.) that fail SSR resolution.
// The domain constant is pure and safe to import directly.
 
import { IDLE_TIMEOUT_MS } from '@/modules/auth/domain/session';
import { portalSignInPath } from '@/lib/portal-paths';

export interface IdleWarningDialogProps {
  /** Where to send the user on involuntary sign-out. */
  readonly portal: 'staff' | 'member';
}

/** 60-second countdown before involuntary sign-out (ux-standards § 8.2). */
const WARNING_WINDOW_MS = 60 * 1000;

/** Warning fires at IDLE_TIMEOUT_MS - WARNING_WINDOW_MS = 29 minutes. */
const WARNING_AFTER_MS = IDLE_TIMEOUT_MS - WARNING_WINDOW_MS;

/**
 * Abort a "Stay signed in" heartbeat that hasn't answered in 10 s — longer than
 * a serverless cold start, far shorter than the 29-min warning window. Bounds
 * how long the in-flight flag can suppress the warning on a hung request: on
 * timeout the fetch aborts → the catch re-opens the warning directly (reWarn).
 */
const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

const ACTIVITY_EVENTS = [
  'mousemove',
  'keydown',
  'click',
  'scroll',
  'touchstart',
] as const;

export function IdleWarningDialog({ portal }: IdleWarningDialogProps) {
  const t = useTranslations('auth.idleWarning');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState(WARNING_WINDOW_MS / 1000);

  // `lastActivityRef` is a ref (not state) so activity listeners don't
  // trigger React re-renders on every mousemove. The idle check is a
  // polling interval that reads the ref. Seed with 0; the mount
  // effect below replaces it with `Date.now()` on the client, keeping
  // the render function pure (react-hooks/purity).
  const lastActivityRef = useRef<number>(0);
  useEffect(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // True while a "Stay signed in" heartbeat is in flight. One ref serves three
  // roles: (1) the countdown's zero-handler skips the involuntary sign-out while
  // a Stay is pending — a tick landing during the round-trip must not override
  // the user's choice (BUG-018); (2) the idle poll does not re-open the warning
  // mid-flight; (3) an overlapping second click is ignored. Cleared in `finally`
  // once the heartbeat settles.
  const stayPendingRef = useRef<boolean>(false);

  // FR-028c: the PaySheet drawer freezes the idle timer during a Stripe payment
  // (pause/resume events wired below). Declared up here so `stayAction`'s reWarn
  // and the countdown can both honour the freeze — not only the idle poll.
  const pausedAtRef = useRef<number | null>(null);

  const signInPath = portalSignInPath(portal);

  /**
   * Involuntarily sign the user out. Called when the 60-second
   * countdown hits zero. Tolerates the sign-out POST failing (if the
   * session is already dead the server returns 200 anyway).
   */
  const forceSignOut = useCallback(async () => {
    setOpen(false);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Swallow — we're redirecting anyway.
    }
    // Dedicated past-tense reason — NOT the countdown copy (which reads
    // "signed out in 0 seconds" and never states the inactivity reason).
    toast.info(t('signedOutInactive'));
    router.replace(signInPath);
    // Force a server round-trip so the layout guard re-runs.
    router.refresh();
  }, [router, signInPath, t]);

  /**
   * "Stay signed in" — heartbeat the server, close the modal optimistically,
   * and extend the client idle clock ONLY if the heartbeat actually extended
   * the server session. `stayPendingRef` (not an optimistic clock reset)
   * suppresses the countdown + poll while the request is in flight.
   */
  const stayAction = useCallback(async () => {
    // Ignore an overlapping click while a heartbeat is already in flight.
    if (stayPendingRef.current) return;
    stayPendingRef.current = true;

    // Close the modal optimistically (BUG-018: never leave the countdown
    // running through the network round-trip). `stayPendingRef` suppresses both
    // the countdown's sign-out and the poll's re-open until the heartbeat
    // settles, so NO optimistic idle-clock reset is needed.
    setRemaining(WARNING_WINDOW_MS / 1000);
    setOpen(false);

    // Re-open the warning to prompt a retry when the heartbeat did NOT extend
    // the session. Done DIRECTLY (setOpen) rather than by staling the idle
    // clock: the activity tracker would reset a stale clock on the user's next
    // mouse move, yet client activity does NOT keep the SERVER session alive —
    // only a successful heartbeat does. No immediate sign-out (BUG-018): the
    // fresh 60 s countdown gives the user another chance to click Stay.
    const reWarn = () => {
      // Do NOT re-open during a PaySheet payment (FR-028c): the idle timer is
      // frozen, and re-warning + counting down here would sign the user out
      // mid-3DS. The payment's own requests keep the server session alive.
      if (pausedAtRef.current !== null) return;
      setOpen(true);
      setRemaining(WARNING_WINDOW_MS / 1000);
    };

    // Bound the request with an AbortController + timer; clearing it in
    // `finally` gives deterministic teardown (and cooperates with the test
    // suite's fake timers), which `AbortSignal.timeout` — whose internal timer
    // runs to completion even after an early resolve — does not.
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      HEARTBEAT_TIMEOUT_MS,
    );
    try {
      const response = await fetch('/api/auth/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      // Only a definitive 401 (no-session) means the session is truly gone —
      // escalate to involuntary sign-out. A 429 (heartbeat rate limit,
      // 60/min/session) or a 5xx (transient Neon/Upstash blip) does NOT mean
      // the session died.
      if (response.status === 401) {
        await forceSignOut();
        return;
      }
      if (response.ok) {
        // The session WAS extended — advance the client idle clock so the poll
        // does not immediately re-warn.
        lastActivityRef.current = Date.now();
      } else {
        // 429/5xx: session NOT extended — re-warn so the user can retry.
        reWarn();
      }
    } catch {
      // Network blip / timeout / abort — session not extended; re-warn.
      reWarn();
    } finally {
      window.clearTimeout(timeoutId);
      stayPendingRef.current = false;
    }
  }, [forceSignOut]);

  // F5 / 009-online-payment amendment (FR-028c):
  // the PaySheet drawer dispatches `swecham:pause-idle-timer` while
  // Stripe payment flows (card submit, 3DS challenge) hold the user's
  // attention without page-level activity. We freeze the idle clock on
  // pause and thaw it on resume, preserving the elapsed-before-pause
  // offset so a user who was already 20 min idle before opening the
  // drawer still only has 9 min left after close.
  //
  // Freeze strategy: when paused, bump `lastActivityRef` forward by the
  // time each poll tick would have accumulated. The simplest, accurate
  // implementation is to track a `pausedAt` timestamp and, on resume,
  // shift `lastActivityRef` forward by `(Date.now() - pausedAt)`.
  useEffect(() => {
    const onPause = () => {
      if (pausedAtRef.current === null) {
        pausedAtRef.current = Date.now();
      }
    };
    const onResume = () => {
      if (pausedAtRef.current !== null) {
        const frozenFor = Date.now() - pausedAtRef.current;
        lastActivityRef.current += frozenFor;
        pausedAtRef.current = null;
      }
    };
    window.addEventListener('swecham:pause-idle-timer', onPause);
    window.addEventListener('swecham:resume-idle-timer', onResume);
    return () => {
      window.removeEventListener('swecham:pause-idle-timer', onPause);
      window.removeEventListener('swecham:resume-idle-timer', onResume);
    };
  }, []);

  // Activity tracker — reset the "last activity" timestamp on any
  // pointer/key event. We do NOT reset it while the modal is open;
  // otherwise the modal would bounce off the first mouse move the user
  // makes to click "Stay signed in".
  useEffect(() => {
    if (open) return;
    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [open]);

  // Idle poll — once every 5 s, check whether we've crossed the
  // warning threshold. 5 s resolution is ample for a 60-second modal.
  useEffect(() => {
    if (open) return;
    const interval = window.setInterval(() => {
      // Freeze while paused by the PaySheet drawer (FR-028c).
      if (pausedAtRef.current !== null) return;
      // Don't re-open the warning while a "Stay signed in" heartbeat is still
      // in flight — its outcome decides whether the clock is fresh (2xx) or the
      // warning should re-appear (failure).
      if (stayPendingRef.current) return;
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor >= WARNING_AFTER_MS) {
        setOpen(true);
        setRemaining(WARNING_WINDOW_MS / 1000);
      }
    }, 5_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open]);

  // Test hook: the a11y E2E spec can dispatch
  // `swecham:open-idle-warning` to force the modal open without
  // simulating 29 minutes of inactivity. Intentionally narrow — no
  // query params, no args, no state leaked out. Same-origin only
  // because the listener lives inside a client component.
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setRemaining(WARNING_WINDOW_MS / 1000);
    };
    window.addEventListener('swecham:open-idle-warning', onOpen);
    return () => {
      window.removeEventListener('swecham:open-idle-warning', onOpen);
    };
  }, []);

  // Countdown — tick once per second while the modal is open, FROZEN during a
  // PaySheet payment (FR-028c). The interval only decrements `remaining`; the
  // sign-out fires from the effect below (never inside the setRemaining updater,
  // which React StrictMode double-invokes in dev — firing the sign-out twice).
  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(() => {
      if (pausedAtRef.current !== null) return; // freeze during payment (FR-028c)
      setRemaining((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open]);

  // Fire the involuntary sign-out when the countdown reaches zero. Guarded by
  // stayPendingRef so a "Stay signed in" heartbeat settling mid-tick does not
  // override the user's explicit choice (BUG-018). forceSignOut flips `open`
  // false, so this fires exactly once per countdown.
  useEffect(() => {
    // Honour the PaySheet pause too (FR-028c): a final decrement tick can land
    // in the same frame a pause is applied, leaving remaining===0 while paused —
    // the sign-out must NOT fire mid-payment. (Consistent with the decrement,
    // poll, and reWarn, which all bail while paused.)
    if (pausedAtRef.current !== null) return;
    if (open && remaining === 0 && !stayPendingRef.current) {
      void forceSignOut();
    }
  }, [open, remaining, forceSignOut]);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription
            // aria-live ensures the screen-reader announces the
            // countdown updates without re-reading the whole dialog.
            aria-live="polite"
          >
            {t('description', { seconds: remaining })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={(event) => {
              event.preventDefault();
              void forceSignOut();
            }}
          >
            {t('signOut')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void stayAction();
            }}
          >
            {t('stay')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
