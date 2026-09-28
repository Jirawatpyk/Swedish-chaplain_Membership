/**
 * While the preferred locale is being fetched, the form shows a named, busy
 * placeholder. `aria-label` needs a role to be permitted (axe
 * `aria-prohibited-attr`), so the placeholder is a `role="status"` region.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PreferredLocaleForm loading state', () => {
  it('is a busy status region named by its loading label', () => {
    // Never resolves, so the form stays in its loading state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PreferredLocaleForm />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('status', { name: en.portal.preferredLocale.loading });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});
