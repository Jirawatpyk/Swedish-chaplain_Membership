// @vitest-environment jsdom
/**
 * Portal error states follow-up — an inline-image upload refused by the
 * read-only proxy. The uploader already read the flat `error` string, so the
 * code was `read-only-mode`; no `errors.read-only-mode` key existed, and the
 * member read "Upload failed. Please try again." inline and in a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import en from '@/i18n/messages/en.json';
import { ComposeInlineImageUploader } from '@/components/broadcast/compose-inline-image-uploader';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'read-only-mode' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'Retry-After': '300' },
        }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('inline image upload during the read-only freeze', () => {
  it('says uploads are paused for maintenance, as a warning', async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ComposeInlineImageUploader draftId="d-1" onUploaded={vi.fn()} />
      </NextIntlClientProvider>,
    );
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    const message = en.portal.broadcasts.compose.imageUpload.errors.read_only_mode;
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(toast.warning).toHaveBeenCalledWith(message);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
