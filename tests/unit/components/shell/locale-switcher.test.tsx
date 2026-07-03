/**
 * LocaleSwitcher unit test — endonym trigger + radio-group locale switch.
 *
 * Base UI's Menu portal uses floating-ui internals that need real timers
 * (same pattern as user-menu.test.tsx). `useLocale()` reads the provider's
 * `locale` prop; `localeLabels` come from config, so passing enMessages for
 * every locale is fine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { runAbortablePersist } from '@/components/shell/locale-persist';

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

// The component delegates the abort-previous + timeout + retry wiring to
// runAbortablePersist; its internals (abort-previous, 8s timeout, retry/4xx,
// onFailed) are covered deterministically in locale-persist.test.ts.
vi.mock('@/components/shell/locale-persist', () => ({
  runAbortablePersist: vi.fn(),
}));

function renderSwitcher(locale: 'en' | 'th' | 'sv' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <LocaleSwitcher />
    </NextIntlClientProvider>,
  );
}

const abortableMock = vi.mocked(runAbortablePersist);

function renderWithPersist(locale: 'en' | 'th' | 'sv' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={enMessages}>
      <LocaleSwitcher persistToAccount />
    </NextIntlClientProvider>,
  );
}

async function pickThai() {
  fireEvent.click(screen.getByRole('button', { name: /change language/i }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'ไทย' }));
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

describe('<LocaleSwitcher persistToAccount>', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useRealTimers();
    refreshSpy.mockClear();
    abortableMock.mockReset();
    document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    cleanup();
    vi.useFakeTimers();
  });

  it('runs the abortable persist with the chosen locale', async () => {
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(abortableMock).toHaveBeenCalledTimes(1));
    // (abortRef, locale, timeoutMs, onFailed) — the signal/timeout wiring is
    // internal to runAbortablePersist (covered in locale-persist.test.ts).
    expect(abortableMock).toHaveBeenCalledWith(
      expect.anything(),
      'th',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('passes an onFailed callback that warns', async () => {
    abortableMock.mockImplementation((_ref, _locale, _ms, onFailed) => {
      onFailed();
    });
    renderWithPersist('en');
    await pickThai();
    await waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
  });

  it('does not persist when persistToAccount is absent (default cookie-only)', async () => {
    renderSwitcher('en'); // no persistToAccount
    await pickThai();
    await new Promise((r) => setTimeout(r, 30));
    expect(abortableMock).not.toHaveBeenCalled();
  });
});
