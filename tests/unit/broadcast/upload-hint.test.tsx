// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1268) — the uploader's two hint paragraphs become one
 * line beside "Upload image" plus an info button holding the full rules (the
 * maintainer, 26 Oct 2026; board `Proposal-compose-inset-upload-tip`).
 *
 * The public-link notice is a PDPA transparency control (F119 F2-11, M-4):
 * it must be known BEFORE the choice. So the short line still says the image
 * is public ("anyone can open"), the button keeps both full sentences as its
 * description, and the info button opens them on a tap, not only on hover.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeInlineImageUploader } from '@/components/broadcast/compose-inline-image-uploader';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const u = enMessages.portal.broadcasts.compose.imageUpload;

function renderUploader(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeInlineImageUploader draftId="d-1" onUploaded={() => {}} />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe('upload hint — one line and an info button (T1268)', () => {
  it('shows one short line that still says the image is public', () => {
    renderUploader();
    expect(screen.getByText(u.shortHelp)).toBeInTheDocument();
    expect(u.shortHelp).toMatch(/public link anyone can open/);
  });

  it('the Upload image button is still described by both full sentences', () => {
    renderUploader();
    const button = screen.getByRole('button', { name: u.uploadButton });
    expect(button).toHaveAccessibleDescription(expect.stringContaining(u.helpText));
    expect(button).toHaveAccessibleDescription(expect.stringContaining(u.publicLinkNotice));
  });

  it('the info button opens the full rules on a tap', () => {
    renderUploader();
    fireEvent.click(screen.getByRole('button', { name: u.aboutUploads }));
    const tip = screen.getByRole('dialog', { name: u.aboutUploads });
    expect(tip).toHaveTextContent(u.helpText);
    expect(tip).toHaveTextContent(u.publicLinkNotice);
  });
});
