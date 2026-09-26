/**
 * `<RelativeTime>` — SSR-safe relative-time renderer.
 *
 * Root-cause fix for hydration mismatches when rendering "X seconds
 * ago" labels: `Date.now()` returns different values on the server
 * (SSR render time) vs the client (hydration time), so a relative-
 * time string crossing a second-boundary produces different HTML on
 * either side and React throws `Hydration failed because the server
 * rendered text didn't match the client.`
 *
 * The standard React 19 / Next.js App Router pattern is the
 * "setState-on-mount" approach: render a STABLE absolute string on
 * the server (so SSR and first-paint hydration are byte-identical),
 * then flip to the relative-time string after `useEffect` runs
 * (client-only, after hydration completes). An optional refresh
 * interval keeps the relative text current on long-lived dashboards.
 *
 * Always emits the canonical ISO into the `dateTime` attribute so
 * AT/screen-readers + JS consumers can read the machine-stable
 * timestamp regardless of which label is currently shown.
 *
 * Why NOT `suppressHydrationWarning`: that pattern silences the
 * warning but the SSR-rendered text is still wrong on first paint
 * (renders an arbitrary client clock-skewed string for ~1 frame
 * before useEffect reconciles). It also masks genuine hydration
 * bugs in adjacent code. The setState-on-mount approach delivers a
 * deterministically-correct first paint.
 *
 * Locale resolution: pulls from `useLocale()` (next-intl) so the
 * caller doesn't have to thread it. The `locale` prop overrides the
 * context value (useful for previews/tests/storybooks). The
 * component MUST mount inside a `<NextIntlClientProvider>` ancestor
 * — `useLocale()` is called unconditionally and throws when no
 * provider is in scope. All Chamber-OS staff/member pages already
 * have a provider at the layout level so this is a no-op for
 * production callers.
 */
'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTimeZone } from 'next-intl';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { formatRelativeTime } from '@/lib/relative-time';

/**
 * Default refresh cadence in milliseconds. Components using this exact
 * value subscribe to a single shared `setInterval` (see
 * `subscribeToSharedTick` below); components passing a custom cadence
 * fall back to a per-instance interval.
 *
 * 30s is sufficient for "minutes ago" precision while keeping clock
 * pressure low even at thousand-row table scale.
 */
const DEFAULT_REFRESH_MS = 30_000;

/**
 * Shared-tick singleton. The first `<RelativeTime>` instance that
 * subscribes spins up a single `setInterval(DEFAULT_REFRESH_MS)`; the
 * last subscriber to unmount tears it down. All subscribers re-render
 * on the same tick (idiomatic publish-subscribe).
 *
 * Why a singleton (R5 follow-up A): a per-instance `setInterval` per
 * `<RelativeTime>` cell scales O(rows) — for a 5000-row members table
 * that's 5000 timers + 5000 setStates per tick. The singleton drops
 * the timer count to 1 and the setState count to N (one per
 * subscriber, unavoidable since each subscriber needs its own React
 * re-render). Memory + CPU pressure is now O(rows) for setState only,
 * not for both setInterval and setState.
 */
const sharedTickSubscribers = new Set<() => void>();
let sharedTickIntervalId: ReturnType<typeof setInterval> | null = null;

function subscribeToSharedTick(cb: () => void): () => void {
  sharedTickSubscribers.add(cb);
  if (sharedTickIntervalId === null) {
    sharedTickIntervalId = setInterval(() => {
      // Snapshot the subscriber list before iteration so a subscriber
      // that unsubscribes mid-tick (e.g. cell unmounts inside its own
      // re-render path) does not mutate the iteration set.
      for (const sub of [...sharedTickSubscribers]) sub();
    }, DEFAULT_REFRESH_MS);
  }
  return () => {
    sharedTickSubscribers.delete(cb);
    if (sharedTickSubscribers.size === 0 && sharedTickIntervalId !== null) {
      clearInterval(sharedTickIntervalId);
      sharedTickIntervalId = null;
    }
  };
}

export interface RelativeTimeProps {
  /** ISO 8601 UTC timestamp (e.g. "2026-05-09T11:27:17.289Z"). */
  readonly iso: string;
  /**
   * Optional className applied to the `<time>` element. Caller
   * controls typography + colour.
   */
  readonly className?: string;
  /**
   * Optional locale override (BCP-47). Defaults to `useLocale()`.
   * Useful for previews/tests.
   */
  readonly locale?: string;
  /**
   * Optional `title` attribute for the underlying `<time>` element.
   * Renders as a native browser tooltip on hover — useful for
   * showing the precise timestamp when the visible label is the
   * relative-time approximation. Caller can pass either a localised
   * absolute date or the raw ISO; the value is forwarded verbatim.
   */
  readonly title?: string;
  /**
   * Refresh cadence in milliseconds. Defaults to 30_000 (30s) which
   * is sufficient for "minutes ago" precision. Pass `0` to disable
   * auto-refresh (renders once on mount and stays).
   */
  readonly refreshMs?: number;
}

/**
 * Format the SSR-safe absolute fallback. Used during the server
 * render AND the first client paint (before `useEffect` flips to
 * relative). Output is stable: same `iso` + same `locale` + same
 * `timeZone` → same string, regardless of when OR WHERE the function
 * runs.
 *
 * INCIDENT 2026-07-31 (prod React #418 on /admin/members +
 * /admin/renewals, operator repro'd in incognito): this formatter used
 * to omit `timeZone`, so `Intl.DateTimeFormat` fell back to the
 * RUNTIME's zone — Vercel server = UTC, user browser = Asia/Bangkok —
 * and SSR emitted DIFFERENT text than hydration for every timestamp
 * (the hour always differed; the calendar day differed for instants
 * ≥ 17:00 UTC). The `mounted` gate below only guards CLOCK drift
 * (`Date.now()` moving between server render and hydration); it cannot
 * help when the pre-mount label ITSELF is computed differently on the
 * two sides. Pinning `timeZone` from the next-intl provider — which
 * supplies the app-global 'Asia/Bangkok' (src/i18n/request.ts) on BOTH
 * server and client — makes the pre-mount output byte-identical.
 */
function formatAbsolute(
  iso: string,
  locale: string,
  timeZone: string | undefined,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      // Defensive fallback for provider-less mounts (unit tests without a
      // timeZone on the provider): matches the app-wide pin +
      // `formatLocalisedDate`'s own Bangkok default.
      timeZone: timeZone ?? 'Asia/Bangkok',
    }).format(date);
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

export function RelativeTime({
  iso,
  className,
  locale: localeProp,
  title,
  refreshMs = DEFAULT_REFRESH_MS,
}: RelativeTimeProps) {
  const localeFromContext = useLocale();
  const locale = localeProp ?? localeFromContext;
  // App-global zone from the next-intl provider ('Asia/Bangkok',
  // src/i18n/request.ts) — identical on server and client, which is what
  // makes the pre-mount absolute label hydration-safe (see formatAbsolute).
  const timeZone = useTimeZone();

  // `mounted` flips from false (SSR + first paint) to true (after
  // hydration). The pre-mount path renders the absolute date which
  // is stable; the post-mount path renders the relative label.
  const [mounted, setMounted] = useState(false);
  // `tick` is a no-op state used solely to force re-render on the
  // refresh interval. We don't need to read it; React only cares
  // that setState was called.
  const [, setTick] = useState(0);

  useEffect(() => {
    // The `setMounted(true)` flip is the canonical setState-on-mount
    // pattern for SSR-safe rendering: server + first paint use the
    // stable absolute fallback; post-hydration flips to relative.
    // The lint rule is reasonable for most cases but this is the
    // documented React 19 pattern (mirrors payment-form.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    if (refreshMs <= 0) return;
    // Default cadence subscribes to the shared-tick singleton so a
    // 5000-row table runs ONE setInterval (not 5000). Custom cadences
    // keep their own per-instance interval — rare path, used when a
    // surface needs sub-30s precision (e.g. live countdowns).
    if (refreshMs === DEFAULT_REFRESH_MS) {
      return subscribeToSharedTick(() => setTick((t) => t + 1));
    }
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const label = mounted
    ? // Post-mount (client-only) — no hydration constraint, but thread the
      // SAME provider zone into the >30-day absolute-date fallback so an
      // old timestamp shows the Bangkok calendar day, consistent with the
      // pre-mount label it replaces.
      formatRelativeTime(iso, locale, new Date(), timeZone ?? 'Asia/Bangkok')
    : formatAbsolute(iso, locale, timeZone);

  return (
    <time dateTime={iso} className={className} title={title}>
      {label}
    </time>
  );
}
