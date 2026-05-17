'use client';

/**
 * SecurityUpdateBanner — F1 Round 3 M2 (post-Round-2 hardening).
 *
 * Originally a server-rendered `<div role="status" aria-live="polite">`
 * with static text. The Round 3 UX review flagged that some legacy
 * screen readers (NVDA pre-2024, older VoiceOver builds) do NOT
 * reliably announce live regions that are populated in the initial
 * server HTML — the live-region announcement is triggered by DOM
 * mutation AFTER the region is attached.
 *
 * This Client Component renders the live region empty on the server
 * (no layout shift since the container is fixed-size), then injects
 * the localised text via `useEffect` after hydration. The mutation
 * triggers the SR announcement reliably across browsers + SR builds.
 *
 * `aria-atomic="true"` ensures the entire region is announced as a
 * single unit even if a future change adds child nodes.
 */
import { useEffect, useState } from 'react';

export interface SecurityUpdateBannerProps {
  /** Pre-translated banner text from the server page's getTranslations. */
  readonly message: string;
}

export function SecurityUpdateBanner({ message }: SecurityUpdateBannerProps) {
  // Render empty on server (matches hydration). useEffect populates on
  // mount → triggers SR live-region announce.
  const [displayedText, setDisplayedText] = useState('');

  useEffect(() => {
    setDisplayedText(message);
  }, [message]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm min-h-[2.5rem]"
    >
      {displayedText}
    </div>
  );
}
