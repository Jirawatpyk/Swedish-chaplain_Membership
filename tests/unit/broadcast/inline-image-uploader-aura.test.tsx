// @vitest-environment jsdom
/**
 * Spec 122 US12d-2 — the inline image uploader on AURA, as the compose boards
 * draw it: "Upload image" is a secondary AURA Button (44px on touch), the
 * wait is an AURA indeterminate Progress, and a refused upload is an AURA
 * danger Alert. The upload path, the size pre-check and the error mapping are
 * pinned by the uploader's other tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { ComposeInlineImageUploader } from '@/components/broadcast/compose-inline-image-uploader';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const copy = en.portal.broadcasts.compose.imageUpload;

function renderUploader(): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ComposeInlineImageUploader draftId="d-1" onUploaded={vi.fn()} />
    </NextIntlClientProvider>,
  );
  return container;
}

function pickFile(container: HTMLElement): void {
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the inline image uploader on AURA', () => {
  it('"Upload image" is a secondary AURA Button with the touch height', () => {
    renderUploader();
    const button = screen.getByRole('button', { name: copy.uploadButton });
    expect(button).toHaveClass('aura-btn--secondary', 'aura-btn--touch');
  });

  it('shows an AURA indeterminate progress while the upload runs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const container = renderUploader();
    pickFile(container);
    const bar = await screen.findByRole('progressbar', { name: copy.uploadingAria });
    expect(bar).toHaveClass('aura-progress__track', 'is-indeterminate');
  });

  it('the button stays focusable while it uploads (aria-disabled + aria-busy, not disabled)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const container = renderUploader();
    pickFile(container);
    await screen.findByRole('progressbar');
    const button = screen.getByRole('button', { name: new RegExp(copy.uploadingLabel) });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  // Round 2 (#15): the toast announces the refusal; the inline danger Alert
  // keeps it in view without announcing it a second time (`role="none"`).
  it('a refused upload is an AURA danger Alert, announced once (by the toast)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unknown' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const container = renderUploader();
    pickFile(container);
    const message = await screen.findByText(copy.errors.unknown);
    expect(message.closest('.aura-alert')).toHaveClass('aura-alert--danger');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
