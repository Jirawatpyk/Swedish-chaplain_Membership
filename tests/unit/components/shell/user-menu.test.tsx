/**
 * 057 — <UserMenu> desktop avatar Account menu (member role). Pins that the
 * dropdown links to the REAL existing routes (/portal/account,
 * /portal/preferences/renewals, /portal/account/data-export), theme controls,
 * and sign-out — all inside a role=menu popup. The earlier `#renewal-prefs` /
 * `#data-privacy` anchors were dead (057 review F7/F8); this test guards
 * against regressing to non-existent anchors.
 *
 * Base UI's MenuPrimitive.Portal uses floating-ui internals that need real
 * timers (setTimeout for positioning). Override global vi.useFakeTimers()
 * with the same pattern used by event-fee-form.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { UserMenu } from '@/components/shell/user-menu';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

function renderMenu() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UserMenu displayName="Jane Member" email="jane@example.com" role="member" />
    </NextIntlClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
}

describe('<UserMenu> member Account hub (057)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('links to the real existing Account / renewal / privacy routes', async () => {
    renderMenu();
    openMenu();
    const account = await screen.findByRole('menuitem', { name: /account settings/i });
    expect(account).toHaveAttribute('href', '/portal/account');
    expect(
      screen.getByRole('menuitem', { name: /renewal/i }),
    ).toHaveAttribute('href', '/portal/preferences/renewals');
    expect(
      screen.getByRole('menuitem', { name: /data & privacy/i }),
    ).toHaveAttribute('href', '/portal/account/data-export');
  });

  it('renders theme controls and a sign-out item', async () => {
    renderMenu();
    openMenu();
    expect(await screen.findByRole('menuitem', { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});
