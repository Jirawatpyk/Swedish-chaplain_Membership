/**
 * R148 — on the E-Blast queue a pager link lands focus on the list itself,
 * not the page top: the SLA card and the halt banner filled the first screen.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueuePagination } from '@/components/broadcast/admin/queue-pagination';

function ui(nextHref: string) {
  return (
    <main id="main-content">
      <div id="eblast-queue-list" tabIndex={-1}>
        <QueuePagination
          label="Queue pages"
          status={null}
          firstPageHref="/admin/broadcasts"
          nextPageHref={nextHref}
          focusTargetId="eblast-queue-list"
        />
      </div>
    </main>
  );
}

describe('E-Blast queue pager focus (R148)', () => {
  it('moves focus to the queue list after a pager link', () => {
    const { rerender } = render(ui('/admin/broadcasts?cursor=a'));
    const next = screen
      .getByRole('navigation', { name: 'Queue pages' })
      .querySelector('a[href="/admin/broadcasts?cursor=a"]');
    expect(next).not.toBeNull();
    fireEvent.click(next as HTMLElement);
    window.history.pushState({}, '', '/admin/broadcasts?cursor=a');
    rerender(ui('/admin/broadcasts?cursor=b'));
    expect(document.activeElement).toBe(document.getElementById('eblast-queue-list'));
  });
});
