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

  // Set synchronously the instant the user clicks "Stay signed in" (before
  // any await), and cleared once that handler settles. The 60→0 countdown
  // keeps ticking during the heartbeat round-trip; this ref lets the
  // countdown's zero-handler know the user already chose to stay, so a tick
  // landing mid-round-trip cannot override that choice (BUG-018).
  const keepAliveRef = useRef<boolean>(false);

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
   * "Stay signed in" action — heartbeat the server, close the modal,
   * reset the local idle clock.
   */
  const stayAction = useCallback(async () => {
    // Mark "the user chose to stay" and close the dialog optimistically
    // BEFORE awaiting the heartbeat. The 60→0 countdown interval keeps
    // ticking until `open` flips false and the effect cleanup clears it;
    // awaiting the heartbeat first (a 1–3 s serverless cold start is
    // common) would leave a window where the countdown hits zero and
    // involuntarily signs the user out despite their click. `keepAliveRef`
    // (read synchronously in the countdown tick) closes that race and the
    // optimistic close ends it — this is the BUG-018 "clicked Stay signed
    // in but got kicked out" defect (TC-AUTH-05 step 2). Bonus: the modal
    // dismisses instantly instead of after the network round-trip.
    keepAliveRef.current = true;
    lastActivityRef.current = Date.now();
    setRemaining(WARNING_WINDOW_MS / 1000);
    setOpen(false);
    try {
      const response = await fetch('/api/auth/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
      });
      // Only a definitive 401 (no-session) means the session is truly gone
      // — escalate to involuntary sign-out. A 429 (heartbeat rate limit,
      // 60/min/session) or a 5xx (transient Neon/Upstash blip) does NOT
      // mean the session died; the row is still valid server-side, so keep
      // the user signed in. The next protected request surfaces any real
      // auth failure (same contract as the ≤1-min-to-absolute-cap edge
      // documented above). Signing out on ANY non-OK response was part of
      // the same BUG-018 fragility.
      if (response.status === 401) {
        await forceSignOut();
      }
    } catch {
      // Network blip — already closed optimistically; the next real
      // request will surface any real auth failure.
    } finally {
      keepAliveRef.current = false;
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
  const pausedAtRef = useRef<number | null>(null);
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

  // Countdown — while the modal is open, tick once per second. Reaching
  // zero triggers the involuntary sign-out path.
  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          // Skip the involuntary sign-out if the user just clicked "Stay
          // signed in": that handler sets keepAliveRef synchronously before
          // awaiting the heartbeat, so a tick landing during the round-trip
          // must not override their explicit choice (BUG-018).
          if (!keepAliveRef.current) {
            void forceSignOut();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [open, forceSignOut]);

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
