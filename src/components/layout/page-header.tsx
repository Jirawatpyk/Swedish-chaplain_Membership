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
   * board's, larger from 1024px only. AURA sizes both (`size`).
   */
  size?: 'default' | 'hero' | 'hero-lg';
  /**
   * AURA #150 — below this breakpoint a detail page's own actions become a
   * bar fixed to the bottom of the screen, with `actionsStatus` as its line
   * (the invoice page). On a screen 480px tall or less (AURA 5.48, #154) the
   * actions stay in the full-width row instead.
   */
  actionsBarBelow?: 'sm' | 'md';
  actionsStatus?: ReactNode;
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
 * - Sizes are AURA's (#152): an ordinary page takes `size="compact"`, the
 *   boards' 26 / 32px title; `hero` and `hero-lg` pass through. The portal
 *   sets the room above a hero title through `--aura-page-header-hero-space`
 *   (globals.css). `data-size` stays on the root for the portal's hero
 *   section gap.
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
  actionsBarBelow,
  actionsStatus,
}: PageHeaderProps) {
  const portal = useDensity() === 'comfortable';
  return (
    <AuraPageHeader
      data-slot="page-header"
      data-size={size}
      size={size === 'default' ? 'compact' : size}
      title={title}
      subtitle={subtitle}
      titleAddon={badge}
      meta={meta}
      eyebrow={eyebrow}
      actions={actions}
      actionsFullWidthBelow="sm"
      actionsBarBelow={actionsBarBelow}
      actionsStatus={actionsStatus}
      actionsAlign={portal ? 'start' : 'end'}
      focusTitleOnMount={autoFocusTitle}
      className={className}
    />
  );
}
