/**
 * Spec 122 US1 T108 — the breadcrumb in AURA's look keeps its contract: the
 * current page is `aria-current="page"` text, a routable parent is a link,
 * an organisational segment (no page of its own) is plain text — never a
 * link to its parent's URL, and never a button that does nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { BreadcrumbNav } from '@/components/layout/breadcrumb-nav';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/settings/renewals/schedules' }));

afterEach(() => cleanup());

describe('BreadcrumbNav (spec 122 US1)', () => {
  it('renders the trail as AURA crumbs: links for pages, text for a segment with no page, the current page last', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <BreadcrumbProvider>
          <BreadcrumbNav placement="bar" />
        </BreadcrumbProvider>
      </NextIntlClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb navigation' });
    expect(nav).toHaveClass('aura-crumbs');
    const [desktop] = within(nav).getAllByRole('list');
    const items = within(desktop!).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Settings has a page: a link.
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/admin/settings');
    // `renewals` has none (NON_ROUTE_BY_PARENT): text, no link, no dead button.
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(within(items[1]!).queryByRole('button')).toBeNull();
    // The current page.
    expect(items[2]!.querySelector('[aria-current="page"]')).not.toBeNull();
  });
});
