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
 * No run-once entry guard (e.g. a `hasStartedRef`) on top of the mount
 * effect: an earlier version used one to stop a second animation pass if
 * `allowMotion` flipped after mount, but that guard is fatal under
 * `reactStrictMode: true` (`next.config.ts`; also how Playwright's e2e dev
 * server runs) — StrictMode intentionally mounts, cleans up, and re-mounts
 * every effect once in development. The cleanup's `cancelAnimationFrame`
 * cancels the first scheduled frame before it ever paints, and the guard
 * then blocked the second (persisting) effect run from scheduling a
 * replacement — so the animation never visibly played in `pnpm dev` or
 * Playwright (production is unaffected; StrictMode double-invoke is
 * dev-only). The effect below has no such guard: it depends on
 * `[value, allowMotion, durationMs]` and simply (re)schedules an rAF loop
 * every time it runs. StrictMode's mount→cleanup→remount is safe because
 * the cleanup (`cancelAnimationFrame`) is symmetric with the effect
 * (`requestAnimationFrame`) — the cancelled first frame never fires, and the
 * second (real) mount schedules its own frame and animates normally.
 */
'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

  useEffect(() => {
    // Reduced motion: leave `display` at the final value, schedule nothing.
    if (!allowMotion) {
      setDisplay(formatter.format(value));
      return;
    }

    let rafId: number;
    let startTime: number | null = null;

    const step = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(1, durationMs > 0 ? elapsed / durationMs : 1);
      if (progress >= 1) {
        // Land exactly on `value` — avoids a rounding/float-epsilon near-miss
        // on the final frame instead of trusting `value * easeOutCubic(1)`.
        setDisplay(formatter.format(value));
        return;
      }
      setDisplay(formatter.format(Math.round(value * easeOutCubic(progress))));
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
    // No entry guard here (see docblock, "No run-once entry guard") — this
    // effect re-runs and reschedules whenever `value`, `allowMotion`, or
    // `durationMs` changes, which is also what makes it StrictMode-safe.
    // `formatter` is intentionally omitted: it's derived from `locale`/
    // `variant` via `useMemo` and re-deriving it inside the effect buys
    // nothing extra here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, allowMotion, durationMs]);

  return <span className={className}>{display}</span>;
}
