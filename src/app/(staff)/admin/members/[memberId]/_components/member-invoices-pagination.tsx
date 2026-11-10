'use client';

/**
 * #765 — the member invoices card's pager (AURA `Pagination`, pages mode).
 * Before, the card read its first 100 invoices and showed no pager, so a
 * member with more hid the rest while the header count said otherwise.
 *
 * A client wrapper only because `getHref` is a function. Each link keeps the
 * page's other query params (the card's `invStatus` / `invYear` / `invQ`
 * filters included), sets `invPage` (dropped for page 1), and ends in
 * `#member-invoices-heading` so following it lands on this card, which sits
 * far down the member page, not at the top.
 */
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Pagination } from '@jirawatpyk/aura-react';

export const MEMBER_INVOICES_PAGE_PARAM = 'invPage';
export const MEMBER_INVOICES_ANCHOR = 'member-invoices-heading';

/**
 * Set when a pager link is followed, read once the new page renders. Module
 * scope, not a ref: the route's `loading.tsx` can unmount this pager while the
 * next page loads, and a remounted pager must still know a page link moved it.
 */
let focusHeadingOnRender = false;

export function MemberInvoicesPagination({
  page,
  pageCount,
  label,
}: {
  readonly page: number;
  readonly pageCount: number;
  /** The nav's accessible name. */
  readonly label: string;
}): React.ReactElement {
  const pathname = usePathname();
  const params = useSearchParams();
  const getHref = (target: number): string => {
    const next = new URLSearchParams(params.toString());
    if (target <= 1) next.delete(MEMBER_INVOICES_PAGE_PARAM);
    else next.set(MEMBER_INVOICES_PAGE_PARAM, String(target));
    const qs = next.toString();
    return `${pathname}${qs ? `?${qs}` : ''}#${MEMBER_INVOICES_ANCHOR}`;
  };
  // The hash scrolls the card's heading into view; focus goes there too, so a
  // keyboard or screen-reader user lands on the card that changed instead of
  // a pager link (or the page body) under 20 rows (WCAG 2.4.3).
  useEffect(() => {
    if (!focusHeadingOnRender) return;
    focusHeadingOnRender = false;
    const heading = document.getElementById(MEMBER_INVOICES_ANCHOR);
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }, [page]);
  return (
    <div
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('a[href]')) focusHeadingOnRender = true;
      }}
    >
      <Pagination pageCount={pageCount} page={page} getHref={getHref} label={label} />
    </div>
  );
}
