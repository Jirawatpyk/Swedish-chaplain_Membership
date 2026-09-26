/**
 * Spec 122 US1 T104 — the staff top bar (`topbar()` on the boards): the
 * search button opens the palette through its window event, the language,
 * colour-scheme and account controls keep their names, and on a phone the
 * colour-scheme choice moves into the account menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { StaffTopBar } from '@/components/layout/staff-top-bar';
import { OPEN_COMMAND_PALETTE_EVENT } from '@/components/command-palette/open-event';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BreadcrumbProvider>
        <StaffTopBar
          tenantName="SweCham"
          user={{ displayName: 'Malin Berg', email: 'malin.berg@example.com', role: 'admin' }}
        />
      </BreadcrumbProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

describe('StaffTopBar (spec 122 US1)', () => {
  it('opens the command palette from the search control', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, opened);
    renderBar();
    const [wide] = screen.getAllByRole('button', { name: 'Open command palette' });
    fireEvent.click(wide!);
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, opened);
  });

  it('keeps the language, colour-scheme and account controls under their names', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /change language/i })).toHaveTextContent('EN');
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('on a phone, offers Light / Dark / System inside the account menu', async () => {
    vi.useRealTimers();
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderBar();
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toBeInTheDocument();
    } finally {
      window.innerWidth = width;
    }
  });
});
