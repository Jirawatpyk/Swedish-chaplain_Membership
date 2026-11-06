/**
 * The /admin/broadcasts queue's keyset footer (spec 122): AURA cursor
 * `Pagination` with the page's own First and Next hrefs and the status line
 * the page passes (the "Showing N of M" summary on the first page).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/messages/en.json';
import { QueuePagination } from '@/components/broadcast/admin/queue-pagination';

const P = en.admin.broadcasts.queue.pagination;

describe('QueuePagination', () => {
  it('is AURA cursor Pagination with the same First and Next hrefs', () => {
    render(
      <QueuePagination
        label={P.label}
        status={null}
        firstPageHref="/admin/broadcasts?status=submitted"
        nextPageHref="/admin/broadcasts?status=submitted&cursor=c2"
      />,
    );
    const nav = screen.getByRole('navigation', { name: P.label });
    expect(nav).toHaveClass('aura-pagination', 'aura-pagination--cursor');
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/admin/broadcasts?status=submitted');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/admin/broadcasts?status=submitted&cursor=c2',
    );
  });

  it('draws no Previous step: the queue only pages forward (AURA 5.84 #197)', () => {
    render(
      <QueuePagination
        label={P.label}
        status={null}
        firstPageHref="/admin/broadcasts"
        nextPageHref="/admin/broadcasts?cursor=c2"
      />,
    );
    expect(screen.getByRole('navigation', { name: P.label })).not.toHaveTextContent(/previous/i);
    expect(screen.queryByRole('link', { name: /previous/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /previous/i })).toBeNull();
  });

  it('shows the status line it is given, and nothing when there is one page only', () => {
    const { unmount } = render(
      <QueuePagination label={P.label} status="Showing 50 of 132" firstPageHref={null} nextPageHref="/admin/broadcasts?cursor=c2" />,
    );
    expect(screen.getByRole('navigation', { name: P.label })).toHaveTextContent('Showing 50 of 132');
    unmount();
    const { container } = render(<QueuePagination label={P.label} status={null} firstPageHref={null} nextPageHref={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
