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

const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: vi.fn() }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

function renderMenu(role: 'member' | 'admin' = 'member') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UserMenu displayName="Jane Member" email="jane@example.com" role={role} />
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

describe('<UserMenu> staff (admin) menu — single Account item, no member extras (E1)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    pushSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('routes the single Account item to /admin/account on click', async () => {
    renderMenu('admin');
    openMenu();
    const account = await screen.findByRole('menuitem', { name: /account settings/i });
    fireEvent.click(account);
    expect(pushSpy).toHaveBeenCalledWith('/admin/account');
  });

  it('does NOT render the member-only renewal / privacy / theme items', async () => {
    renderMenu('admin');
    openMenu();
    // Account item present (proves the menu opened) — then assert the
    // member-only extras are absent for staff.
    await screen.findByRole('menuitem', { name: /account settings/i });
    expect(screen.queryByRole('menuitem', { name: /renewal/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /data & privacy/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /light/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /dark/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /system/i })).toBeNull();
    // Sign-out stays available for staff.
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});
