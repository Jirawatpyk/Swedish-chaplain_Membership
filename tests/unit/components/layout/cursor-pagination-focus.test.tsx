/**
 * #84 — following a cursor pager link (First / Next) moves focus to the page's
 * main landmark once the next page renders, instead of dropping it on <body>
 * when the route's loading.tsx unmounts the pager.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CursorPagination } from '@/components/layout/cursor-pagination';

function ui(nextHref: string) {
  return (
    <main id="main-content">
      <p>List</p>
      <CursorPagination label="Pages" showFirst showPrevious={false} hasFirst firstHref="/list" nextHref={nextHref} />
    </main>
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('CursorPagination keeps focus (#84)', () => {
  it('moves focus to #main-content after a pager link', () => {
    const { rerender } = render(ui('/list?cursor=a'));
    const next = screen.getByRole('navigation', { name: 'Pages' }).querySelector('a[href="/list?cursor=a"]');
    expect(next).not.toBeNull();
    fireEvent.click(next as HTMLElement);
    rerender(ui('/list?cursor=b'));
    expect(document.activeElement).toBe(document.getElementById('main-content'));
  });

  it('leaves focus alone on a first render', () => {
    render(ui('/list?cursor=a'));
    expect(document.activeElement).toBe(document.body);
  });
});
