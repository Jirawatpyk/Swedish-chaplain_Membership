'use client';

import { useSyncExternalStore } from 'react';

/**
 * `true` below Tailwind's `sm` breakpoint (640px) — the width at which the
 * staff pages move their header actions into a bar at the bottom of the
 * screen. `false` on the server and on the first client render, so the
 * markup matches; it updates when the viewport crosses 640px.
 */
const QUERY = '(max-width: 639.98px)';

// A browser without `matchMedia` (some embedded views, jsdom) reads as wide.
const hasMatchMedia = () => typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function useBelowSm(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && window.matchMedia(QUERY).matches,
    () => false,
  );
}
