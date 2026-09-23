// @vitest-environment jsdom
/**
 * F119 follow-up — the member directory logo sat on a hard-coded `bg-white`
 * patch, which glares in dark mode (same defect T155 U16 closed on the Brand
 * settings logo). It now uses the same themed transparency checker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
});

function renderControl(): HTMLElement {
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <DirectoryLogoControl currentLogoUrl="https://blob.example/logo.png" />
    </NextIntlClientProvider>,
  );
  return screen.getByAltText(en.directorySettings.logoCurrent);
}

describe('DirectoryLogoControl logo backing', () => {
  it('carries no bg-white', () => {
    const img = renderControl();
    const backing = img.closest('[data-testid="directory-logo-preview"]') ?? img;
    expect(`${backing.className} ${img.className}`).not.toMatch(/\bbg-white\b/);
  });

  it('uses a themed surface with the shared transparency checker', () => {
    renderControl();
    const backing = screen.getByTestId('directory-logo-preview');
    expect(backing.className).toMatch(/\bbg-card\b/);
    expect(backing.style.backgroundImage).toMatch(/gradient/);
  });
});
