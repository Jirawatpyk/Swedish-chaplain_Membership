'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
  /**
   * Staff-Review-2026-05-09 Round-2 R2-W2 fix: auto-focus the H1 on
   * mount via React-owned ref instead of the previous external
   * `<AutoFocusH1>` component which mutated `tabIndex` directly on
   * the DOM. Use on routes the user was server-redirected to (e.g.
   * `/portal/renewal/[memberId]/success` after F5 returns from
   * Stripe) so screen-reader + keyboard users land at the heading
   * instead of the previous page's last-focused element (WCAG 2.4.3).
   */
  autoFocusTitle?: boolean;
};

/**
 * Margin/padding use CSS logical properties so this renders correctly
 * in both LTR and future RTL locales without any changes at the call
 * site.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  badge,
  className,
  autoFocusTitle = false,
}: PageHeaderProps) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!autoFocusTitle) return;
    const h1 = titleRef.current;
    if (h1) {
      h1.focus({ preventScroll: true });
    }
  }, [autoFocusTitle]);

  return (
    <header
      data-slot="page-header"
      className={cn(
        // Below Tailwind's sm breakpoint (640px) stack title + actions
        // vertically so action groups wrap cleanly on mobile. `items-stretch`
        // on mobile gives the actions row full container width so multiple
        // buttons have room to wrap into a proper grid and tap targets
        // don't bunch up against the left edge. Desktop (sm+) reverts to
        // `items-start` so title + actions sit naturally side-by-side.
        //
        // No margin-block-end: vertical spacing between PageHeader and
        // the following Cards/content is owned by the parent layout
        // container's `flex flex-col gap-[var(--page-section-gap)]`.
        // Previously the margin here + the parent's gap doubled to 48 px
        // on pages that opted into flex-gap wrappers.
        'flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:flex-wrap sm:items-start',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/*
           * R4-W10 (staff-review-2026-05-09): when the heading is auto-
           * focused after a server-redirect (e.g. Stripe success), pair
           * focus with `aria-live="polite"` so SR engines that don't
           * announce focused-but-not-live headings (NVDA) still surface
           * the page change. VoiceOver re-announces the focused element
           * regardless; this complements rather than competes.
           */}
          <h1
            ref={titleRef}
            data-slot="page-header-title"
            className="text-h1 text-foreground focus-visible:outline-none"
            tabIndex={autoFocusTitle ? -1 : undefined}
            aria-live={autoFocusTitle ? 'polite' : undefined}
          >
            {title}
          </h1>
          {badge}
        </div>
        {subtitle ? (
          // <div> (not <p>) because `subtitle` is typed `ReactNode` and
          // callers pass arbitrary elements (e.g. <SkeletonBlock> = a
          // <div>) from `loading.tsx`. A <p> with a <div> descendant
          // breaks HTML validity and triggers a React 19 hydration
          // error.
          <div
            data-slot="page-header-subtitle"
            className="[margin-block-start:0.25rem] text-body text-muted-foreground"
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? (
        // Mobile (<640px): `[&>*]:flex-1` makes every action child stretch
        // to share the full-width row equally — maximises tap targets on
        // narrow viewports per WCAG 2.5.5 / 2.5.8 and avoids buttons
        // bunching against the left edge.
        // Desktop (sm+): `sm:[&>*]:flex-none` reverts children to their
        // natural width so the action group sits neatly on the right of
        // the title.
        <div
          data-slot="page-header-actions"
          className="flex flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
