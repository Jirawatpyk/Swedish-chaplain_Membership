/**
 * F114 US6 (FR-033; plan Complexity Tracking #2) — the staff nav item renders
 * its server-resolved `badgeCount` INSIDE the link, so the count is part of
 * the link's accessible name ("Change requests 3 pending" — the short noun,
 * UX L1), carries the count into the icon-rail tooltip ("Change requests (3)",
 * UX L3 — the rail hides the badge), and renders nothing badge-shaped when the
 * count is 0 / absent.
 *
 * The sidebar primitives are stubbed: `SidebarMenuButton` composes a Base UI
 * `useRender` + Tooltip and `useSidebar` needs the provider + `matchMedia`;
 * neither is the property under test (the DOM the link carries is).
 */
import type { ReactElement, ReactNode } from 'react';
import { cloneElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ClipboardCheckIcon } from 'lucide-react';
import en from '@/i18n/messages/en.json';
import { NavEntry } from '@/components/layout/nav-item';
import type { RenderedNavItem } from '@/config/nav';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  // `tooltip` is forwarded as a data attribute so the rail signal is testable.
  SidebarMenuButton: ({ render: el, children, tooltip }: { render: ReactElement; children: ReactNode; tooltip?: string }) =>
    cloneElement(el, { 'data-tooltip': tooltip } as Record<string, unknown>, children),
  SidebarMenuSub: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuSubButton: ({ render: el, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(el, {}, children),
}));

const base: RenderedNavItem = {
  titleKey: 'nav.staff.changeRequests',
  icon: ClipboardCheckIcon,
  href: '/admin/change-requests',
  activePattern: '/admin/change-requests',
  badge: { labelKey: 'nav.staff.changeRequestsBadge' },
};

function renderItem(item: RenderedNavItem) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ul>
        <NavEntry item={item} />
      </ul>
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('NavItemLink badge (F114 US6)', () => {
  it('a positive badgeCount is in the accessible name: count + sr-only suffix', () => {
    renderItem({ ...base, badgeCount: 3 });
    const link = screen.getByRole('link', { name: 'Change requests 3 pending' });
    expect(link).toHaveAttribute('href', '/admin/change-requests');
    // the visible number, then the suffix hidden visually but read by AT
    expect(link).toHaveTextContent('3');
    expect(link.querySelector('.sr-only')).toHaveTextContent('pending');
    // no role-less aria-label (axe aria-prohibited-attr) anywhere in the link
    expect(link.querySelector('span[aria-label]')).toBeNull();
  });

  it('singular count reads the same short noun', () => {
    renderItem({ ...base, badgeCount: 1 });
    expect(screen.getByRole('link', { name: 'Change requests 1 pending' })).toBeInTheDocument();
  });

  it('the tooltip carries the count when a badge is present (UX L3 — the icon rail hides the badge)', () => {
    const { unmount } = renderItem({ ...base, badgeCount: 3 });
    expect(screen.getByRole('link', { name: 'Change requests 3 pending' })).toHaveAttribute('data-tooltip', 'Change requests (3)');
    unmount();
    renderItem(base);
    expect(screen.getByRole('link', { name: 'Change requests' })).toHaveAttribute('data-tooltip', 'Change requests');
  });

  it('an item WITHOUT a badge declaration renders no badge even when a count rides along (B2)', () => {
    const { badge: _badge, ...noDeclaration } = base;
    renderItem({ ...noDeclaration, badgeCount: 3 });
    // never "Change requests 3" — a number with no noun to announce it
    expect(screen.getByRole('link', { name: 'Change requests' })).toBeInTheDocument();
    expect(screen.queryByText('3')).toBeNull();
  });

  it('renders no badge at 0 and when badgeCount is absent — the name is the title alone', () => {
    const { unmount } = renderItem({ ...base, badgeCount: 0 });
    expect(screen.getByRole('link', { name: 'Change requests' })).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
    unmount();
    renderItem(base);
    const link = screen.getByRole('link', { name: 'Change requests' });
    expect(link.querySelector('.sr-only')).toBeNull();
  });
});
