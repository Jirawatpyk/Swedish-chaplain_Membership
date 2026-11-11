'use client';

/**
 * Spec 122 — AURA `Pagination` in cursor mode (5.70) for keyset lists, so a
 * Server Component can render it: AURA's barrel is client-only, and every prop
 * here is serialisable (string hrefs, booleans, a status node). The callbacks
 * (`onFirst` / `onPrevious` / `onNext`) are left out on purpose — the links are
 * real `<a>`s through AuraBridge's `linkComponent`, so paging works without
 * JavaScript and the back button keeps working.
 *
 * #84 — following First / Next re-renders the page through the route's
 * `loading.tsx`, which unmounts this pager, so focus fell to `<body>` (WCAG
 * 2.4.3). A followed link's href is kept at module scope (not a ref: the pager
 * remounts), and once that page renders focus moves to
 * `focusTargetId` — by default `#main-content`, AppShell's skip-link target —
 * and it is scrolled to the top of the list's page.
 */
import { useEffect } from 'react';
import { Pagination, type CursorPaginationProps } from '@jirawatpyk/aura-react';
import { isPlainClick } from '@/lib/plain-click';

export type CursorPaginationLinksProps = Omit<
  CursorPaginationProps,
  'mode' | 'onFirst' | 'onPrevious' | 'onNext' | 'linkComponent'
> & {
  /** Where focus goes after a page link; defaults to the main landmark. */
  readonly focusTargetId?: string;
};

/**
 * The href of the link just followed (path + query), or null. Focus moves only
 * when the page that renders is that href, so a stale value (the destination
 * rendered no pager, or an error page) never pulls focus on a later list.
 */
let followedHref: string | null = null;

/** Path + query of an href, resolved against this page (relative or absolute). */
function pathAndQuery(href: string): string {
  const url = new URL(href, window.location.href);
  return url.pathname + url.search;
}

export function CursorPagination({
  focusTargetId = 'main-content',
  ...props
}: CursorPaginationLinksProps): React.ReactElement {
  useEffect(() => {
    if (followedHref === null) return;
    const here = window.location.pathname + window.location.search;
    const matches = pathAndQuery(followedHref) === here;
    followedHref = null;
    if (!matches) return;
    const target = document.getElementById(focusTargetId);
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'start' });
  }, [props.firstHref, props.nextHref, props.previousHref, focusTargetId]);
  return (
    <div
      onClickCapture={(e) => {
        // A modified click opens another tab or window; this page stays put.
        if (!isPlainClick(e)) return;
        const href = (e.target as HTMLElement).closest('a[href]')?.getAttribute('href');
        if (href) followedHref = href;
      }}
    >
      <Pagination mode="cursor" {...props} />
    </div>
  );
}
