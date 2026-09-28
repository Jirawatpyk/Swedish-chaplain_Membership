// @vitest-environment jsdom
/**
 * F119 follow-up — the member directory logo sits on the SAME backing as the
 * Brand settings logo preview: a fixed light checker (the white every mail
 * client and most web pages composite a logo on). A themed checker hid dark
 * logos in dark mode (F119 UX review).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';
import { toast } from '@/lib/toast';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

/**
 * Portal error states follow-up — a failed REMOVAL said "Could not upload the
 * logo (PNG/JPEG/WebP, max 2 MB)": the upload's copy, naming formats and a
 * size limit that have nothing to do with deleting.
 */
describe('DirectoryLogoControl — a failed removal says removal', () => {
  async function confirmRemove(): Promise<void> {
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: en.directorySettings.logoRemove }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.directorySettings.logoRemoveConfirm }));
  }

  it.each([
    ['the server refuses', () => vi.fn(async () => new Response('{}', { status: 500 }))],
    ['the network drops', () => vi.fn(async () => { throw new TypeError('Failed to fetch'); })],
  ])('%s → the removal message, never the upload one', async (_case, makeFetch) => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', makeFetch());
    await confirmRemove();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.directorySettings.logoRemoveFailed),
    );
    expect(toast.error).not.toHaveBeenCalledWith(en.directorySettings.logoFailed);
  });
});
