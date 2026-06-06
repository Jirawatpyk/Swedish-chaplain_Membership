/**
 * 057 — <MemberBottomTabs> mobile tab bar. Pins: 5 tabs, visible short labels,
 * aria-current="page" on active, ≥44px touch targets, unique nav aria-label,
 * and the mobile-only (lg:hidden) wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';

const mockPathname = vi.fn<() => string>(() => '/portal');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

function renderTabs() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberBottomTabs />
    </NextIntlClientProvider>,
  );
}

describe('<MemberBottomTabs> (057 mobile tab bar)', () => {
  it('renders 5 tab links inside a uniquely-labelled nav', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    const nav = screen.getByRole('navigation', { name: 'Member tab bar' });
    expect(nav).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('every tab exposes the full label as its accessible name', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Benefits' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument();
  });

  it('shows the compact short label text for overflow-prone tabs', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    // Account tab's visible text uses the short label "Account" (en short == full),
    // and Benefits uses "Benefits"; assert the visible <span> text exists.
    const benefits = screen.getByRole('link', { name: 'Benefits' });
    expect(benefits.textContent).toContain('Benefits');
  });

  it('sets aria-current="page" on the active tab', () => {
    mockPathname.mockReturnValue('/portal/account');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Benefits active on /portal/broadcasts/** (review M-2)', () => {
    mockPathname.mockReturnValue('/portal/broadcasts/abc');
    renderTabs();
    expect(screen.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });

  it('each tab is a ≥44px touch target (WCAG 2.5.8)', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('min-h-[44px]');
    }
  });

  it('is mobile-only — the nav carries lg:hidden + safe-area padding', () => {
    mockPathname.mockReturnValue('/portal');
    renderTabs();
    const nav = screen.getByRole('navigation', { name: 'Member tab bar' });
    expect(nav.className).toContain('lg:hidden');
    expect(nav.className).toContain('pb-[env(safe-area-inset-bottom)]');
  });
});
