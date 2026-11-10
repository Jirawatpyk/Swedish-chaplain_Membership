/**
 * #765 review (UX M1 / a11y H1) — following an invoices pager link lands
 * focus on the card's heading once the new page renders, not on a pager link
 * under 20 rows or on the page body.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members/m-1',
  useSearchParams: () => new URLSearchParams(''),
}));

const { MemberInvoicesPagination, MEMBER_INVOICES_ANCHOR } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-pagination'
);

function ui(page: number) {
  return (
    <>
      <h2 id={MEMBER_INVOICES_ANCHOR}>Invoices</h2>
      <MemberInvoicesPagination page={page} pageCount={4} label="Invoice pages" />
    </>
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('member invoices pager focus (#765)', () => {
  it('moves focus to the card heading after a page link', () => {
    const { rerender } = render(ui(2));
    const link = screen.getByRole('navigation', { name: 'Invoice pages' }).querySelector('a[href*="invPage=3"]');
    expect(link).not.toBeNull();
    fireEvent.click(link as HTMLElement);
    rerender(ui(3));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Invoices' }));
  });

  it('leaves focus alone on a first render', () => {
    render(ui(2));
    expect(document.activeElement).toBe(document.body);
  });
});
