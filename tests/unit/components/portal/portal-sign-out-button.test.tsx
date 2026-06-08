import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PortalSignOutButton } from '@/components/portal/portal-sign-out-button';

const pushSpy = vi.fn();
const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, refresh: refreshSpy }),
}));
const errorSpy = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => errorSpy(...a) } }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalSignOutButton />
    </NextIntlClientProvider>,
  );
}

describe('<PortalSignOutButton>', () => {
  beforeEach(() => {
    // Real timers required: global setup.ts enables fake timers (setTimeout faked);
    // waitFor() + Promise resolution needs real timers. Same pattern as user-menu.test.tsx.
    vi.useRealTimers();
    pushSpy.mockClear();
    refreshSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('POSTs to /api/auth/sign-out and routes to /portal/sign-in on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(pushSpy).toHaveBeenCalledWith('/portal/sign-in'));
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/sign-out', { method: 'POST' });
    expect(refreshSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('toasts on a non-ok response and does NOT navigate', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(pushSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('toasts signOutNetworkError on a thrown fetch error and does NOT navigate', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Failed to fetch'));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(pushSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
