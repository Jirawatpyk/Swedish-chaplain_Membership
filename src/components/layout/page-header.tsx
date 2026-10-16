'use client';

import type { ReactNode } from 'react';
import { PageHeader as AuraPageHeader, useDensity } from '@jirawatpyk/aura-react';

type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** A chip on the title's line (a role, an invoice's status, "Archived"); AURA's `titleAddon`. */
  badge?: ReactNode;
  /** Chips on their own row under the subtitle (the portal `Main` board's member number, plan and status). */
  meta?: ReactNode;
  /** Chips on their own row above the title (the staff `Admin-member-detail` board's status, member number and badges). */
  eyebrow?: ReactNode;
  className?: string;
  /**
   * Focus the heading when the header mounts, for routes the user was
   * server-redirected to (e.g. `/portal/renewal/[memberId]/success` after F5
   * returns from Stripe), so screen-reader and keyboard users start at the
   * heading (WCAG 2.4.3). AURA's `focusTitleOnMount`.
   */
  autoFocusTitle?: boolean;
  /**
   * Spec 122 — `hero` is the larger page the portal home and edit boards
   * draw: a 30 / 36px title and more room above it; `hero-lg` is the Benefits
   * board's, larger from 1024px only (26 / 36px). Every other page uses the
   * default 26 / 32px. globals.css sizes the title and the page padding off
   * `data-size`.
   */
  size?: 'default' | 'hero' | 'hero-lg';
};

/**
 * Spec 122 (2026-10-16, AURA #151) — the page header is AURA's `PageHeader`;
 * this wrapper keeps the app's props so no call site changes.
 *
 * - Below 640px the actions take the whole row under the text
 *   (`actionsFullWidthBelow="sm"`).
 * - Staff boards align the actions with the bottom of the text; the portal
 *   boards with its top. The portal renders under `density="comfortable"`
 *   (`AuraDensity` in its layout), so that is the signal.
 * - `size` is not handed to AURA: the title size (`--font-size-h1` per
 *   `data-size`, which globals.css points AURA's title at) and the room above
 *   a hero page (the portal container's padding) stay the app's, as the
 *   boards draw them.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  badge,
  meta,
  eyebrow,
  className,
  autoFocusTitle = false,
  size = 'default',
}: PageHeaderProps) {
  const portal = useDensity() === 'comfortable';
  return (
    <AuraPageHeader
      data-slot="page-header"
      data-size={size}
      title={title}
      subtitle={subtitle}
      titleAddon={badge}
      meta={meta}
      eyebrow={eyebrow}
      actions={actions}
      actionsFullWidthBelow="sm"
      actionsAlign={portal ? 'start' : 'end'}
      focusTitleOnMount={autoFocusTitle}
      className={className}
    />
  );
}
