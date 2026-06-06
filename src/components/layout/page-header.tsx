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
        {/*
         * 056 polish FIX 1 (WCAG 1.4.10 Reflow) — `flex-wrap` lets the
         * badge chips drop to a new line on narrow viewports instead of
         * overflowing past 320 px. `min-w-0` on both the row container
         * and the h1 enable the text to shrink below its intrinsic width
         * before the layout overflows. This is purely additive: pages
         * that pass no badge are unaffected (the empty slot renders
         * nothing; `break-words` on h1 is safe everywhere).
         */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/*
           * R4 + Round-5 review-finding H4: focus-only announcement
           * pattern. R4-W10 had paired `tabIndex={-1}.focus()` with
           * `aria-live="polite"` to "complement rather than compete",
           * but the round-5 review found that NVDA + JAWS announce
           * the focused heading AND re-announce the live-region
           * update on the next tick — SR users hear the heading
           * twice (WCAG 4.1.3 / WAI-ARIA APG anti-pattern). Drop
           * the live region and rely on focus-only announcement,
           * which NVDA + JAWS + VoiceOver all surface reliably for
           * `tabIndex={-1}` headings.
           */}
          <h1
            ref={titleRef}
            data-slot="page-header-title"
            className="min-w-0 break-words text-h1 text-foreground focus-visible:outline-none"
            tabIndex={autoFocusTitle ? -1 : undefined}
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
