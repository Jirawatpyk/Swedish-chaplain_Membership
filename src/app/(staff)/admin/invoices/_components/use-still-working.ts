'use client';

/**
 * #724 review (UX M3) — true once a money POST has been pending for
 * STILL_WORKING_AFTER_MS, so the dialog can say it is still working instead
 * of showing "Issuing…" alone for up to the 75 s timeout.
 */
import { useEffect, useState } from 'react';

export const STILL_WORKING_AFTER_MS = 10_000;

export function useStillWorking(pending: boolean): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setStill(true), STILL_WORKING_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setStill(false);
    };
  }, [pending]);
  // Gated on `pending`, so a finished request never shows a stale note.
  return pending && still;
}
