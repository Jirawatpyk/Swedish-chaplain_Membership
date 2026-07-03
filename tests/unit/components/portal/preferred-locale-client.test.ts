import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  updatePreferredLocale,
  PREFERRED_LOCALE_ENDPOINT,
} from '@/components/portal/preferred-locale-client';

describe('updatePreferredLocale', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('PATCHes the endpoint with the locale body + same-origin creds', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await updatePreferredLocale('th');
    expect(fetchSpy).toHaveBeenCalledWith(
      PREFERRED_LOCALE_ENDPOINT,
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: 'th' }),
      }),
    );
  });

  it('threads an AbortSignal through when provided', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const ac = new AbortController();
    await updatePreferredLocale('en', ac.signal);
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('signal', ac.signal);
  });

  it('omits signal from the request init when not provided', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await updatePreferredLocale(null);
    expect(fetchSpy.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});
