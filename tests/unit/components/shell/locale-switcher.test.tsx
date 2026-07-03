/**
 * LocaleSwitcher unit test — endonym trigger + radio-group locale switch.
 *
 * Base UI's Menu portal uses floating-ui internals that need real timers
 * (same pattern as user-menu.test.tsx). `useLocale()` reads the provider's
 * `locale` prop; `localeLabels` come from config, so passing enMessages for
 * every locale is fine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

function renderSwitcher(locale: 'en' | 'th' | 'sv' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <LocaleSwitcher />
    </NextIntlClientProvider>,
  );
}

describe('<LocaleSwitcher>', () => {
  beforeEach(() => {
    vi.useRealTimers();
    refreshSpy.mockClear();
    document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('shows the current-language endonym on the trigger', () => {
    renderSwitcher('en');
    expect(
      screen.getByRole('button', { name: /change language/i }),
    ).toHaveTextContent('English');
  });

  it('opens a radio group of all three locales with the active one checked', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    const en = await screen.findByRole('menuitemradio', { name: 'English' });
    expect(en).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('menuitemradio', { name: 'ไทย' }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: 'Svenska' })).toBeInTheDocument();
  });

  it('writes NEXT_LOCALE=th and refreshes when Thai is chosen', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'ไทย' }));
    expect(document.cookie).toContain('NEXT_LOCALE=th');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the already-active locale is re-selected', async () => {
    renderSwitcher('en');
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }));
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
