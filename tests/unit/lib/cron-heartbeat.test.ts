/**
 * `pingCronHeartbeat` — dead-man's-switch ping for a cron (healthchecks.io
 * protocol). Pins: success → `<url>`, failure → `<url>/fail`, no-op when
 * unset, and NEVER throws (a monitoring hiccup must not fail the cron).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const warnMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn: warnMock, info: vi.fn(), error: vi.fn() } }));

import { pingCronHeartbeat } from '@/lib/cron-heartbeat';

const URL_ = 'https://hc-ping.com/1111-2222';

function stubFetch(impl: (url: string) => Promise<{ ok: boolean; status: number }>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe('pingCronHeartbeat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('no-op when the URL is unset (never calls fetch)', async () => {
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }));
    await pingCronHeartbeat(undefined, 'success', { cron: 'c' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('success → GET <url>', async () => {
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }));
    await pingCronHeartbeat(URL_, 'success', { cron: 'c' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(URL_);
  });

  it('failure → GET <url>/fail (tolerates a trailing slash)', async () => {
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }));
    await pingCronHeartbeat(`${URL_}/`, 'fail', { cron: 'c' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${URL_}/fail`);
  });

  it('never throws when the ping errors / times out — logs a warning instead', async () => {
    stubFetch(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(pingCronHeartbeat(URL_, 'success', { cron: 'c' })).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cron: 'c', errName: 'TimeoutError' }),
      'cron.heartbeat.ping_failed',
    );
  });

  it('a non-2xx response is logged, not thrown', async () => {
    stubFetch(async () => ({ ok: false, status: 404 }));
    await expect(pingCronHeartbeat(URL_, 'success', { cron: 'c' })).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      'cron.heartbeat.ping_rejected',
    );
  });
});
