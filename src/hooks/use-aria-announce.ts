/**
 * R6 verify-fix Errors-MEDIUM + Simplify-#2 (2026-05-02) — shared
 * aria-live announcement hook.
 *
 * Pairs a visually-hidden `role="status" aria-live="polite"` region
 * (rendered by the consuming component) with a setter that auto-clears
 * after `resetMs`. Tracks the timer in a ref so:
 *   1. Unmount during the announcement window cancels the pending
 *      `setAnnouncement` (closes the React-state-update-after-unmount
 *      leak flagged by code-reviewer + errors auditor in /speckit.review R5).
 *   2. Consecutive announce() calls cancel the previous timer so the
 *      most-recent message is the one that gets cleared.
 *
 * Use alongside sonner toasts for SR a11y per docs/ux-standards.md
 * § 15 (toasts alone are not reliably announced across SR×browser
 * combos).
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAriaAnnounce {
  readonly announcement: string;
  readonly announce: (msg: string) => void;
}

export function useAriaAnnounce(resetMs: number = 3000): UseAriaAnnounce {
  const [announcement, setAnnouncement] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const announce = useCallback(
    (msg: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setAnnouncement(msg);
      timerRef.current = setTimeout(() => {
        setAnnouncement('');
        timerRef.current = null;
      }, resetMs);
    },
    [resetMs],
  );

  return { announcement, announce };
}
