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
import { BreadcrumbBackLink, BreadcrumbNav } from '@/components/layout/breadcrumb-nav';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/settings/renewals/schedules' }));

afterEach(() => cleanup());

describe('BreadcrumbNav (spec 122 US1)', () => {
  it('renders the trail as AURA crumbs: links for pages, text for a segment with no page, the current page last', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <BreadcrumbProvider>
          <BreadcrumbNav />
        </BreadcrumbProvider>
      </NextIntlClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb navigation' });
    expect(nav).toHaveClass('aura-crumbs');
    const [desktop] = within(nav).getAllByRole('list');
    const items = within(desktop!).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // AURA #94 (5.15): the e2e slots ride AURA's own itemProps, the list slot its wrapper
    expect(items.every((li) => li.getAttribute('data-slot') === 'breadcrumb-item')).toBe(true);
    expect(nav.parentElement).toHaveAttribute('data-slot', 'breadcrumb-list');
    // Settings has a page: a link.
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/admin/settings');
    // `renewals` has none (NON_ROUTE_BY_PARENT): text, no link, no dead button.
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(within(items[1]!).queryByRole('button')).toBeNull();
    // The current page.
    expect(items[2]!.querySelector('[aria-current="page"]')).not.toBeNull();
  });

  const wrap = (node: React.ReactNode) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <BreadcrumbProvider>{node}</BreadcrumbProvider>
      </NextIntlClientProvider>,
    );

  it('shows a top-level page as the current crumb alone, and the dashboard as "Dashboard"', () => {
    wrap(<BreadcrumbNav pathname="/admin/members" />);
    let nav = screen.getByRole('navigation', { name: 'Breadcrumb navigation' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(1);
    expect(within(nav).getByText('Members')).toHaveAttribute('aria-current', 'page');
    cleanup();
    wrap(<BreadcrumbNav pathname="/admin" />);
    nav = screen.getByRole('navigation', { name: 'Breadcrumb navigation' });
    expect(within(nav).getByText('Dashboard')).toHaveAttribute('aria-current', 'page');
  });

  it('gives phones a back link to the parent page instead of the trail, and nothing on a top-level page', () => {
    wrap(<BreadcrumbBackLink pathname="/admin/settings/renewals/schedules" />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/admin/settings');
    cleanup();
    const { container } = wrap(<BreadcrumbBackLink pathname="/admin/members" />);
    expect(container).toBeEmptyDOMElement();
  });
});
