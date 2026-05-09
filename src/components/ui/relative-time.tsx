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
 * caller doesn't have to thread it. Pass `locale` explicitly when
 * the component is invoked outside a next-intl context (rare).
 */
'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { formatRelativeTime } from '@/lib/relative-time';

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
   * Refresh cadence in milliseconds. Defaults to 30_000 (30s) which
   * is sufficient for "minutes ago" precision. Pass `0` to disable
   * auto-refresh (renders once on mount and stays).
   */
  readonly refreshMs?: number;
}

/**
 * Format the SSR-safe absolute fallback. Used during the server
 * render AND the first client paint (before `useEffect` flips to
 * relative). Output is stable: same `iso` + same `locale` → same
 * string, regardless of when the function runs.
 */
function formatAbsolute(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const bcp47 =
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale === 'sv' ? 'sv-SE' : locale;
  try {
    return new Intl.DateTimeFormat(bcp47, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

export function RelativeTime({
  iso,
  className,
  locale: localeProp,
  refreshMs = 30_000,
}: RelativeTimeProps) {
  const localeFromContext = useLocale();
  const locale = localeProp ?? localeFromContext;

  // `mounted` flips from false (SSR + first paint) to true (after
  // hydration). The pre-mount path renders the absolute date which
  // is stable; the post-mount path renders the relative label.
  const [mounted, setMounted] = useState(false);
  // `tick` is a no-op state used solely to force re-render on the
  // refresh interval. We don't need to read it; React only cares
  // that setState was called.
  const [, setTick] = useState(0);

  useEffect(() => {
    setMounted(true);
    if (refreshMs <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const label = mounted
    ? formatRelativeTime(iso, locale)
    : formatAbsolute(iso, locale);

  return (
    <time dateTime={iso} className={className}>
      {label}
    </time>
  );
}
