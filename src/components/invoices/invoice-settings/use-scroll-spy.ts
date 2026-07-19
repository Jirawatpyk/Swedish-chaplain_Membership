'use client';
import { useEffect, useRef, useState } from 'react';

export interface ScrollSpyResult {
  readonly active: string | null;
  /**
   * code-review follow-up (finding 5) — lets a consumer (SectionNav's
   * `goToSection`) optimistically set the active section the instant a
   * jump is triggered, rather than waiting for the IntersectionObserver
   * callback to fire once the smooth-scroll settles.
   */
  readonly setActive: (id: string) => void;
}

export function useScrollSpy(sectionIds: readonly string[]): ScrollSpyResult {
  const [active, setActive] = useState<string | null>(sectionIds[0] ?? null);
  // code-review follow-up (finding 4) — the IntersectionObserver callback
  // only reports entries whose intersection STATE CHANGED since the last
  // callback (a batch of one or more sections), not every currently-
  // intersecting section. Picking `visible[0]` from just that batch could
  // therefore pick a section that isn't even the topmost intersecting one
  // — e.g. if section A is already intersecting and unchanged, and section
  // B independently starts intersecting further down the page, a batch
  // containing only B would wrongly promote B to `active` even though A is
  // still above it. Accumulate every section's last-known state across
  // callbacks in this ref, then recompute the topmost-intersecting section
  // from the FULL map on every callback.
  const stateRef = useRef(new Map<string, { intersecting: boolean; top: number }>());

  useEffect(() => {
    const els = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const state = stateRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          if (!id) continue;
          state.set(id, {
            intersecting: entry.isIntersecting,
            top: entry.boundingClientRect.top,
          });
        }
        const visible = [...state.entries()]
          .filter(([, s]) => s.intersecting)
          .sort((a, b) => a[1].top - b[1].top);
        // Retain the last active section once nothing intersects (e.g. the
        // user is between two sections) — the nav's aria-current would
        // otherwise vanish mid-scroll.
        if (visible.length > 0) setActive(visible[0]![0]);
      },
      // rootMargin lifts the "active" band toward the top; the negative
      // bottom margin lets a short LAST section win once it scrolls near top.
      { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.1, 0.5, 1] },
    );
    els.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      state.clear();
    };
  }, [sectionIds]);

  return { active, setActive };
}
