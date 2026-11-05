/**
 * The /admin/broadcasts queue's keyset footer (spec 122): AURA cursor
 * `Pagination` with the page's own First and Next hrefs and, on the first
 * page, the "Showing N of M" summary as its status line.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { renderQueuePagination } from '@/components/broadcast/admin/queue-pagination';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));

const P = en.admin.broadcasts.queue.pagination;

describe('renderQueuePagination', () => {
  it('is AURA cursor Pagination with the same First and Next hrefs', async () => {
    render(
      (await renderQueuePagination({
        firstPageHref: '/admin/broadcasts?status=submitted',
        nextPageHref: '/admin/broadcasts?status=submitted&cursor=c2',
        shown: 50,
        viewTotal: 132,
      })) as ReactElement,
    );
    const nav = screen.getByRole('navigation', { name: P.label });
    expect(nav).toHaveClass('aura-pagination', 'aura-pagination--cursor');
    expect(screen.getByRole('link', { name: P.first })).toHaveAttribute('href', '/admin/broadcasts?status=submitted');
    expect(screen.getByRole('link', { name: P.next })).toHaveAttribute(
      'href',
      '/admin/broadcasts?status=submitted&cursor=c2',
    );
  });
});
