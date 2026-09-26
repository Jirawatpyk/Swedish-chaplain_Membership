/**
 * Spec 122 US1 T103 — the staff navigation on AURA SideNav keeps the legacy
 * sidebar's contract: the same permission-filtered entries (FR-011), the
 * badge inside the link's accessible name (F114 US6 B2), one current page,
 * Settings folded into a group that opens on its own routes, and the rail
 * choice persisted in the `sidebar_state` cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { StaffNav } from '@/components/layout/staff-nav';
import { flattenNavItems, staffNavConfig } from '@/config/nav';

const nav = vi.hoisted(() => ({ pathname: '/admin/members' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const ALL_HREFS = flattenNavItems(staffNavConfig).map((item) => item.href);
const FLAGS = { broadcastsEnabled: true, eventsEnabled: true, memberChangeApproval: true };

function renderNav(props: Partial<Parameters<typeof StaffNav>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <StaffNav tenantName="SweCham" allowedHrefs={ALL_HREFS} navVisibilityFlags={FLAGS} {...props} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  nav.pathname = '/admin/members';
  document.cookie = 'sidebar_state=; max-age=0; path=/';
});
afterEach(() => cleanup());

describe('StaffNav (spec 122 US1)', () => {
  it('is the "Staff navigation" landmark with the board\'s section titles', () => {
    renderNav();
    const landmark = screen.getByRole('navigation', { name: 'Staff navigation' });
    for (const title of ['Membership', 'Finance', 'Engagement', 'System', 'Compliance']) {
      expect(within(landmark).getByText(title)).toBeInTheDocument();
    }
  });

  it('shows only the entries the viewer may open — an empty allow-list fails closed', () => {
    const { unmount } = renderNav({ allowedHrefs: ['/admin', '/admin/members'] });
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/admin/members');
    expect(screen.queryByRole('link', { name: 'Invoices' })).toBeNull();
    unmount();
    renderNav({ allowedHrefs: [] });
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
  });

  it('marks exactly one entry as the current page, the most specific match', () => {
    nav.pathname = '/admin/settings/broadcasts/brand';
    renderNav();
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('E-Blast brand');
  });

  it('keeps a badge count inside the link\'s accessible name, and renders none at 0', () => {
    const { unmount } = renderNav({ navBadgeCounts: { '/admin/change-requests': 3 } });
    expect(screen.getByRole('link', { name: 'Change requests 3 pending' })).toHaveAttribute(
      'href',
      '/admin/change-requests',
    );
    unmount();
    renderNav({ navBadgeCounts: { '/admin/change-requests': 0 } });
    expect(screen.getByRole('link', { name: 'Change requests' })).toBeInTheDocument();
  });

  it('folds Settings into one group, closed elsewhere and open on a settings route', () => {
    const { unmount } = renderNav();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'false');
    unmount();
    nav.pathname = '/admin/settings/invoicing';
    renderNav();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Invoice settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('starts in the rail the cookie asked for, and saves the next choice to it', () => {
    renderNav({ defaultCollapsed: true });
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    fireEvent.click(expand);
    expect(document.cookie).toContain('sidebar_state=true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(document.cookie).toContain('sidebar_state=false');
  });

  it('toggles the rail on Ctrl+B, but not while typing (Bold)', () => {
    renderNav();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(document.cookie).toContain('sidebar_state=false');
    const field = document.createElement('textarea');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    field.remove();
  });

  it('lets the portal badge drop below the brand rather than cut the wordmark (SV "Personal", TH)', () => {
    renderNav();
    // Layout is measured in the harness (a 240px nav: SV/TH badges push the
    // wordmark to "SweC…" inline); here the row must be allowed to wrap, and
    // a long tenant name still truncates on its own line.
    const badge = screen.getByText('Staff');
    expect(badge.closest('.flex-wrap')).not.toBeNull();
    expect(screen.getByText('SweCham')).toHaveClass('truncate');
  });

  it('never offers the rail toggle inside the phone drawer (AppShell passes collapsible=false)', () => {
    renderNav({ collapsed: false, collapsible: false });
    expect(screen.queryByRole('button', { name: /collapse sidebar|expand sidebar/i })).toBeNull();
  });
});
