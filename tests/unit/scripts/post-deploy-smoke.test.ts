/**
 * `scripts/post-deploy-smoke.ts` (spec 123 US1, DW-2).
 *
 * The smoke passes only when both sign-in pages answer 200 with a password
 * input and `/api/health` answers 200 `{"status":"ok"}`. It retries the whole
 * set, and a FAIL line never carries a response body. `fetch` is stubbed;
 * nothing leaves the process.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSmoke } from '../../../scripts/post-deploy-smoke';

const SIGN_IN_HTML = '<form><input id="password" type="password" name="password"/></form>';
const HEALTH_OK = '{"status":"ok"}';

type Route = { status: number; body: string };
type Table = Record<string, Route>;

const healthy: Table = {
  '/admin/sign-in': { status: 200, body: SIGN_IN_HTML },
  '/portal/sign-in': { status: 200, body: SIGN_IN_HTML },
  '/api/health': { status: 200, body: HEALTH_OK },
};

/** A fetch stub that answers from one table per attempt (the last one repeats). */
function stubFetch(...attempts: Table[]) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const round = Math.floor((seen.length - 1) / 3);
    const table = attempts[Math.min(round, attempts.length - 1)]!;
    const route = table[url.pathname];
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(route.body, { status: route.status });
  });
  return { fetchImpl, seen };
}

function opts(fetchImpl: typeof fetch, attempts = 1) {
  return { fetchImpl, attempts, delayMs: 0, log: vi.fn() };
}

describe('runSmoke', () => {
  it('passes when every check is healthy, one PASS line per check', async () => {
    const { fetchImpl, seen } = stubFetch(healthy);

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      'PASS admin-sign-in 200',
      'PASS portal-sign-in 200',
      'PASS health 200',
    ]);
    expect(seen.sort()).toEqual(['/admin/sign-in', '/api/health', '/portal/sign-in']);
  });

  it('fails when /api/health is 503', async () => {
    const { fetchImpl } = stubFetch({
      ...healthy,
      '/api/health': { status: 503, body: '{"status":"degraded"}' },
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toContain('FAIL health 503');
  });

  it('fails when /api/health is 200 with any other body', async () => {
    const { fetchImpl } = stubFetch({
      ...healthy,
      '/api/health': { status: 200, body: '{"status":"ok","db":"x"}' },
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toContain('FAIL health 200-unexpected-body');
  });

  it('fails when a sign-in page is 500, without printing the body', async () => {
    const { fetchImpl } = stubFetch({
      ...healthy,
      '/portal/sign-in': { status: 500, body: 'Internal error at db.secret.host' },
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toContain('FAIL portal-sign-in 500');
    expect(result.lines.join('\n')).not.toContain('secret');
  });

  it('cancels the unread body of a non-200 response, so the socket is released', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetchImpl = vi.fn(async () => ({ status: 500, body: { cancel }, text: vi.fn() }) as unknown as Response);

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toContain('FAIL health 500');
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it('fails when a sign-in page has no password input', async () => {
    const { fetchImpl } = stubFetch({
      ...healthy,
      '/admin/sign-in': { status: 200, body: '<html><body>Maintenance</body></html>' },
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toContain('FAIL admin-sign-in 200-no-password-input');
  });

  it('fails a network error as network-error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([
      'FAIL admin-sign-in network-error',
      'FAIL portal-sign-in network-error',
      'FAIL health network-error',
    ]);
  });

  it('retries and succeeds on attempt 2, reporting only the final attempt', async () => {
    const { fetchImpl } = stubFetch(
      { ...healthy, '/api/health': { status: 503, body: '{"status":"degraded"}' } },
      healthy,
    );
    const o = opts(fetchImpl as unknown as typeof fetch, 3);

    const result = await runSmoke('https://swecham.example', o);

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(result.lines.every((l) => l.startsWith('PASS '))).toBe(true);
    // The retry notice goes to the log, never as a FAIL line.
    expect(o.log).toHaveBeenCalled();
    expect(o.log.mock.calls.flat().join('\n')).not.toMatch(/^FAIL /m);
  });

  it('stops after the configured attempts and keeps failing', async () => {
    const { fetchImpl } = stubFetch({
      ...healthy,
      '/api/health': { status: 503, body: '{"status":"degraded"}' },
    });

    const result = await runSmoke('https://swecham.example', opts(fetchImpl as unknown as typeof fetch, 3));

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(result.lines).toContain('FAIL health 503');
  });

  it.each(['ftp://swecham.example', 'javascript:alert(1)', 'swecham.example', '', 'https://user:pw@swecham.example'])(
    'rejects base URL %j without fetching',
    async (base) => {
      const fetchImpl = vi.fn();

      const result = await runSmoke(base, opts(fetchImpl as unknown as typeof fetch));

      expect(result.ok).toBe(false);
      expect(result.lines).toEqual(['FAIL base-url invalid']);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('accepts a trailing slash on the base URL', async () => {
    const { fetchImpl, seen } = stubFetch(healthy);

    const result = await runSmoke('http://localhost:3400/', opts(fetchImpl as unknown as typeof fetch));

    expect(result.ok).toBe(true);
    expect(seen).toContain('/api/health');
  });
});
