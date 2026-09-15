/**
 * F114 US6 (FR-033; plan Complexity Tracking #2) — the staff nav item renders
 * its server-resolved `badgeCount` INSIDE the link, so the count is part of
 * the link's accessible name ("Change requests 3 pending change requests"),
 * and renders nothing badge-shaped when the count is 0 / absent.
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
import type { NavItem } from '@/config/nav';

vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: el, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(el, {}, children),
  SidebarMenuSub: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuSubItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuSubButton: ({ render: el, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(el, {}, children),
}));

const base: NavItem = {
  titleKey: 'nav.staff.changeRequests',
  icon: ClipboardCheckIcon,
  href: '/admin/change-requests',
  activePattern: '/admin/change-requests',
  badgeLabelKey: 'nav.staff.changeRequestsBadge',
};

function renderItem(item: NavItem) {
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
    const link = screen.getByRole('link', { name: 'Change requests 3 pending change requests' });
    expect(link).toHaveAttribute('href', '/admin/change-requests');
    // the visible number, then the suffix hidden visually but read by AT
    expect(link).toHaveTextContent('3');
    expect(link.querySelector('.sr-only')).toHaveTextContent('pending change requests');
    // no role-less aria-label (axe aria-prohibited-attr) anywhere in the link
    expect(link.querySelector('span[aria-label]')).toBeNull();
  });

  it('singular count reads as one request', () => {
    renderItem({ ...base, badgeCount: 1 });
    expect(screen.getByRole('link', { name: 'Change requests 1 pending change request' })).toBeInTheDocument();
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
