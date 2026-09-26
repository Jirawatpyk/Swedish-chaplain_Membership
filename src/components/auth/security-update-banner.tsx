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
 *
 * Spec 122 US2: drawn as an AURA info Alert (its classes and icon). Not the
 * `Alert` component itself, whose own `role="status"` would nest a second
 * live region inside this one and cannot take `aria-atomic`.
 */
import { useEffect, useState } from 'react';
import { Icon } from '@jirawatpyk/aura-react';

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

  // The live region is always mounted (so the text appearing is announced);
  // the visible box only once there is text, so the server HTML never shows
  // an empty box with just an icon before hydration.
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="min-h-[2.5rem]">
      {displayedText ? (
        <div className="aura-alert aura-alert--info">
          <Icon name="info" className="aura-alert__icon" />
          <div className="aura-alert__body">
            <div className="aura-alert__text">{displayedText}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
