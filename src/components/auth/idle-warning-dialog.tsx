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
// eslint-disable-next-line no-restricted-imports
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
    toast.info(t('description', { seconds: 0 }));
    router.replace(signInPath);
    // Force a server round-trip so the layout guard re-runs.
    router.refresh();
  }, [router, signInPath, t]);

  /**
   * "Stay signed in" action — heartbeat the server, close the modal,
   * reset the local idle clock.
   */
  const stayAction = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        // Session is already gone server-side — force sign-out.
        await forceSignOut();
        return;
      }
    } catch {
      // Network blip — close modal optimistically; the next real
      // request will surface any real auth failure.
    }
    lastActivityRef.current = Date.now();
    setRemaining(WARNING_WINDOW_MS / 1000);
    setOpen(false);
  }, [forceSignOut]);

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
          void forceSignOut();
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
