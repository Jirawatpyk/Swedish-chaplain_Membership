/**
 * 057 — <MemberNav> desktop top-nav. Pins: 4 visible-text links,
 * aria-current="page" on the active route (incl. Benefits staying active
 * on /portal/broadcasts/**), and the desktop-only (hidden < lg) wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberNav } from '@/components/layout/member-nav';

const mockPathname = vi.fn<() => string>(() => '/portal');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

function renderNav() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberNav />
    </NextIntlClientProvider>,
  );
}

describe('<MemberNav> (057 desktop top-nav)', () => {
  it('renders exactly 4 links with VISIBLE text labels', () => {
    mockPathname.mockReturnValue('/portal');
    renderNav();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benefits' })).toBeInTheDocument();
  });

  it('sets aria-current="page" on the active route only', () => {
    mockPathname.mockReturnValue('/portal/profile');
    renderNav();
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Benefits active on /portal/broadcasts/** (review M-2)', () => {
    mockPathname.mockReturnValue('/portal/broadcasts/new');
    renderNav();
    expect(screen.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });

  it('is desktop-only — the nav element carries the lg-visible / hidden classes', () => {
    mockPathname.mockReturnValue('/portal');
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Member navigation' });
    expect(nav.className).toContain('hidden');
    expect(nav.className).toContain('lg:flex');
  });
});
