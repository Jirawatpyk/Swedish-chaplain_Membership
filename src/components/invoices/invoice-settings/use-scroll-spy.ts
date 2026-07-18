'use client';
import { useEffect, useState } from 'react';

export function useScrollSpy(sectionIds: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(sectionIds[0] ?? null);
  useEffect(() => {
    const els = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      // rootMargin lifts the "active" band toward the top; the negative
      // bottom margin lets a short LAST section win once it scrolls near top.
      { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.1, 0.5, 1] },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sectionIds]);
  return active;
}
