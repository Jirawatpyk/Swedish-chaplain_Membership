'use client';

/**
 * The browser's unsaved-changes prompt, armed by a boolean.
 *
 * Extracted from `use-compose-dirty-guard.ts` (F119 T143) when T155 finding
 * U18 needed the same guard on Brand settings: both compose surfaces warned on
 * the way out, Brand silently discarded an edited colour. The dirty RULE
 * differs per surface — compose compares a subject/body snapshot, Brand
 * compares against the last saved settings view — so what is shared is only
 * the listener, not the comparison.
 */
import { useEffect } from 'react';

export function useBeforeUnloadGuard(armed: boolean): void {
  useEffect(() => {
    if (!armed) return undefined;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string and show their own copy;
      // preventDefault + returnValue is the cross-browser invocation pattern.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [armed]);
}
