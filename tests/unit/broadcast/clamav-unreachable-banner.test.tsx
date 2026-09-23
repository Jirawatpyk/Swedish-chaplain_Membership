// @vitest-environment jsdom
/**
 * F119 walk U34 — the ClamAV health probe polled `/api/internal/clamav/health`
 * on mount and every 30 s, and that route does not exist: every open compose
 * tab logged a 404 every 30 s. Until a real health route ships, the banner
 * mounted the way `tiptap-editor.tsx` mounts it (no endpoint) must make NO
 * request and render nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { ClamavUnreachableBanner } from '@/components/broadcast/clamav-unreachable-banner';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('ClamavUnreachableBanner without a health endpoint (U34)', () => {
  it('makes no request and renders nothing', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
        <ClamavUnreachableBanner />
      </NextIntlClientProvider>,
    );
    // Let the mount effect and any microtask it queued run.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
