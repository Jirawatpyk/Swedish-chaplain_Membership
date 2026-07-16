/**
 * Task 15 (067-dashboard-interactive-charts) — "rolling number" count-up
 * animation for the dashboard's headline KPI cards, added mid-execution per
 * user request (`.superpowers/sdd/task-15-brief.md`).
 *
 * **Why `locale` + `variant` instead of a `format: (n) => string` prop:**
 * `StaffHomePage` (the caller, `src/app/(staff)/admin/(home)/page.tsx`) is a
 * Server Component; this is a Client Component (`'use client'`). Functions
 * are not serializable across the Server→Client Component boundary — an
 * initial version of this component took a `format` function prop and Next
 * threw "Functions cannot be passed directly to Client Components" at
 * runtime (caught before ship). Only plain data (numbers/strings) can cross
 * that boundary, so the formatter is built HERE, from `locale` (string) +
 * `variant` (string literal) — both serializable — and MUST mirror
 * `page.tsx`'s own `numberFmt` / `thbFmt` construction exactly (see
 * `buildFormatter` below) so the rendered string is byte-identical to what
 * the page would have rendered without the animation.
 *
 * SSR-safe / no hydration mismatch: both the server render AND the first
 * client render output the FINAL formatted number, via the
 * `useState(() => format(value))` lazy initializer, so no-JS, screen
 * readers, SEO crawlers, and CLS measurement all see the real number
 * immediately. The count-up itself only starts afterwards, in the mount
 * effect below, and is entirely client-only.
 *
 * Avoiding a visible final→0 flash: nothing sets state synchronously when
 * the effect runs — it only *schedules* the first `requestAnimationFrame`.
 * That very first animation frame doubles as the "reset to 0" (progress=0
 * at elapsed=0), so the SSR/hydration-painted final value stays on screen
 * right up until the animation's own first frame, with no separate
 * intermediate paint of "final value, now interactive" before it drops to 0.
 *
 * Reduced motion (WCAG): reuses `./use-motion-preference`'s
 * `useSyncExternalStore` triad (the same idiom every other 067 chart uses —
 * see `_mini-series-chart.tsx`) rather than re-deriving the `matchMedia`
 * check locally. `getServerAllowMotion` always returns `false`, so the
 * default (server render + first client render, before the browser's real
 * preference is known) is "no animation" — matching the SSR-safe value
 * above. When motion is NOT allowed, the mount effect returns immediately
 * and `display` simply stays at the final formatted value forever.
 *
 * A11y: deliberately NO `aria-live` — a live region re-announcing every
 * intermediate animation frame would spam screen readers. The rendered
 * text IS the number; SR users read it at rest (the final value), same as
 * any other static text node.
 *
 * Re-animating when `value`/`locale`/`variant` changes is intentionally NOT
 * implemented — the dashboard renders once per page load from a cached
 * snapshot, so a single mount-time animation is enough (see task brief).
 * `hasStartedRef` guards against a second run if `allowMotion` itself
 * changes after mount (e.g. the OS-level `prefers-reduced-motion` toggles
 * mid-animation).
 */
'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

/** Ease-out cubic — starts fast, settles gently into the final value. */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export type CountUpVariant = 'integer' | 'thb';

/**
 * Mirrors `page.tsx`'s own formatter construction 1:1 so `<CountUp>` never
 * drifts from what the (non-animated) card would have rendered:
 *   - 'integer' → `numberFmt` (thousands-separated count — total/active/atRisk)
 *   - 'thb'     → `thbFmt` (THB currency, 0 fraction digits — YTD revenue,
 *                 already converted satang→baht by the caller)
 */
function buildFormatter(locale: string, variant: CountUpVariant): Intl.NumberFormat {
  if (variant === 'thb') {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'THB',
      maximumFractionDigits: 0,
    });
  }
  return new Intl.NumberFormat(locale);
}

export function CountUp({
  value,
  locale,
  variant,
  durationMs = 800,
  className,
}: {
  /** Display-unit number (an integer count, OR THB baht — NEVER satang). */
  readonly value: number;
  readonly locale: string;
  readonly variant: CountUpVariant;
  readonly durationMs?: number;
  readonly className?: string;
}) {
  const allowMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getAllowMotion,
    getServerAllowMotion,
  );
  const formatter = useMemo(() => buildFormatter(locale, variant), [locale, variant]);
  // SSR AND the first client render both show the FINAL formatted value —
  // see the docblock above for why this must be a lazy initializer, not a
  // plain `useState(0)`.
  const [display, setDisplay] = useState(() => formatter.format(value));
  const hasStartedRef = useRef(false);

  useEffect(() => {
    // Animate once on mount only — see docblock ("re-animating ... NOT
    // implemented"). Reduced motion: leave `display` at the final value,
    // schedule nothing.
    if (hasStartedRef.current || !allowMotion) return;
    hasStartedRef.current = true;

    let rafId: number;
    let startTime: number | null = null;

    const step = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(1, durationMs > 0 ? elapsed / durationMs : 1);
      setDisplay(formatter.format(Math.round(value * easeOutCubic(progress))));
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      }
    };
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
    // Mount-once animation (see docblock's "Re-animating ... NOT
    // implemented") — value/formatter/durationMs are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowMotion]);

  return <span className={className}>{display}</span>;
}
