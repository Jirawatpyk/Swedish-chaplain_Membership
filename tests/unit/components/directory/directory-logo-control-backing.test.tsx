// @vitest-environment jsdom
/**
 * F119 follow-up — the member directory logo sits on the SAME backing as the
 * Brand settings logo preview: a fixed light checker (the white every mail
 * client and most web pages composite a logo on). A themed checker hid dark
 * logos in dark mode (F119 UX review).
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
  it('sits on a fixed light checker, not a theme token', () => {
    renderControl();
    const backing = screen.getByTestId('directory-logo-preview');
    expect(backing.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(backing.style.backgroundImage).toMatch(/gradient/);
    expect(backing.style.backgroundImage).not.toContain('var(');
    expect(backing.className).not.toMatch(/\bbg-card\b/);
  });
});
