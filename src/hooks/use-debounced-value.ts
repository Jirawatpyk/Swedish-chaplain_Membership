/**
 * useDebouncedValue — trailing-edge debounce for a changing value.
 *
 * Returns a value that only updates after `delayMs` has elapsed since
 * the last change to `value`. The timer resets on every change, so
 * rapid keystrokes collapse into a single update once the user pauses.
 *
 * Introduced for the F5 member cmdk-pay palette to cap the search
 * fetch rate well under the 30 req/min server rate-limit. A 14-char
 * invoice number would otherwise fire 14 requests back-to-back.
 *
 * Parameters
 * ----------
 * - value: the source value to debounce (re-referenced on every render
 *   by the caller is fine — the effect only re-runs when it changes).
 * - delayMs: milliseconds of quiescence before the debounced value
 *   catches up. 200 ms is the F5 default; 150–300 ms is a reasonable
 *   band for palette-style search UX.
 */
'use client';

import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
