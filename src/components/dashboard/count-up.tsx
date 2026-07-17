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
 * **Fixing the "final number flashes, then jumps to 0, then counts up" bug**
 * (user-reported): the ORIGINAL version of this component initialized
 * `display` to the FINAL formatted value (for SSR/no-JS/SEO parity), then a
 * mount effect reset it to 0 before animating — so the very first thing a
 * real browser painted was the final number, which then visibly snapped to
 * 0 a moment later. The fix is to split the "correct final number" and "the
 * animated visual" into two DIFFERENT nodes instead of one node that changes
 * identity over time:
 *
 *   - The VISIBLE, animated `<span aria-hidden>` ALWAYS starts at the START
 *     value (0) — on the server render AND the first client render alike —
 *     and only ever counts UP from there. There is no final→0 transition to
 *     see because the visible node never shows the final value until the
 *     animation actually arrives at it.
 *   - A `sr-only` sibling `<span>` (server-rendered, never animates) always
 *     holds the FINAL formatted value, so screen readers, no-JS, and SEO
 *     crawlers still get the real number immediately — mirroring the
 *     sr-only-table technique already used by `chart-data-table.tsx` /
 *     `_mini-series-chart.tsx` elsewhere in this feature.
 *
 * CLS: the visible number's rendered width grows as digits are added
 * (`0` → `67`, `฿0` → `฿2,000,000`), which would otherwise shift the KPI
 * card layout every frame. An invisible, `aria-hidden` sizer holding the
 * FINAL string reserves the box's width up front (in normal flow); the
 * animated number is positioned `absolute` on top of it, so it grows/shrinks
 * inside a box that itself never resizes.
 *
 * Reduced motion (WCAG): reuses `./use-motion-preference`'s
 * `useSyncExternalStore` triad (the same idiom every other 067 chart uses —
 * see `_mini-series-chart.tsx`) rather than re-deriving the `matchMedia`
 * check locally. `getServerAllowMotion` always returns `false`, so the
 * default (server render + first client render, before the browser's real
 * preference is known) is "no animation yet" — consistent with the visible
 * number starting at 0 regardless. When motion is NOT allowed, the mount
 * effect makes exactly one synchronous jump straight to the final value
 * (no rAF loop) — a single 0→final jump is fine since there's no animation
 * to interrupt.
 *
 * A11y: deliberately NO `aria-live` on the animating span — a live region
 * re-announcing every intermediate animation frame would spam screen
 * readers. Screen readers read the `sr-only` final-value span instead,
 * which never changes after its (server-rendered) first paint.
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
 * `[value, allowMotion, durationMs, finalDisplay]` and simply (re)schedules
 * an rAF loop every time it runs. StrictMode's mount→cleanup→remount is safe
 * because the cleanup (`cancelAnimationFrame`) is symmetric with the effect
 * (`requestAnimationFrame`) — the cancelled first frame never fires, and the
 * second (real) mount schedules its own frame and animates normally.
 */
'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
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
  // The correct, final formatted string — used by the sr-only span (always)
  // and as the animation's landing value. Recomputed on every render (cheap:
  // one Intl.NumberFormat#format call) so it's never stale relative to
  // `value`/`formatter`.
  const finalDisplay = formatter.format(value);

  // SSR AND the first client render both show the START value (0) — see the
  // docblock above ("Fixing the final→0 flash bug"): this is what guarantees
  // the visible number only ever counts UP, never flashes the final value
  // first.
  const [display, setDisplay] = useState(() => formatter.format(0));

  useEffect(() => {
    if (!allowMotion) {
      // Reduced motion: no animation — jump straight to the final value in
      // one synchronous set. Schedule nothing.
      setDisplay(finalDisplay);
      return;
    }

    let rafId: number;
    let startTime: number | null = null;

    const step = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(1, durationMs > 0 ? elapsed / durationMs : 1);
      if (progress >= 1) {
        // Land exactly on the final string — avoids a rounding/float-epsilon
        // near-miss on the final frame instead of trusting
        // `value * easeOutCubic(1)`.
        setDisplay(finalDisplay);
        return;
      }
      setDisplay(formatter.format(Math.round(value * easeOutCubic(progress))));
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
    // No entry guard here (see docblock, "No run-once entry guard") — this
    // effect re-runs and reschedules whenever its inputs change, which is
    // also what makes it StrictMode-safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, allowMotion, durationMs, finalDisplay]);

  return (
    <span className={cn('relative inline-block tabular-nums', className)}>
      {/* Width sizer (CLS guard): reserves the box width the FINAL string
          needs, in normal flow, so the KPI card never reflows as the
          animated digits grow (e.g. `0` → `67`, `฿0` → `฿2,000,000`).
          Invisible + aria-hidden: never seen, never announced — purely a
          layout placeholder for the absolutely-positioned animated number
          below. */}
      <span aria-hidden="true" className="invisible">
        {finalDisplay}
      </span>
      {/* The animated, visual copy — always starts at 0 and counts up on the
          client (see docblock). aria-hidden because screen readers get the
          real number from the sr-only span below instead, so they never
          hear intermediate animation frames — deliberately no `aria-live`
          either, for the same reason. */}
      <span aria-hidden="true" className="absolute inset-0">
        {display}
      </span>
      {/* The accessible copy: always the FINAL value, server-rendered, never
          animates. */}
      <span className="sr-only">{finalDisplay}</span>
    </span>
  );
}
