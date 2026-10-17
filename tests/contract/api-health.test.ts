/**
 * GET /api/health contract test (spec 123 US1, DW-3).
 *
 * The route is a public liveness probe for the post-deploy smoke workflow:
 *   - 200 {"status":"ok"} when `select 1` answers
 *   - 503 {"status":"degraded"} when it throws or does not answer within 3 s
 *     (raced in Node — the Neon pooler drops `statement_timeout`)
 *   - `Cache-Control: no-store`, and the body is one of those two fixed strings
 *   - the probe PROMISE is cached for 10 s (ok and degraded alike), so N
 *     concurrent requests and a flood within the window cost one query
 *   - a degraded result is logged by error CLASS only, never `e.message`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
const warnMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
  },
}));

const OK_BODY = '{"status":"ok"}';
const DEGRADED_BODY = '{"status":"degraded"}';

async function loadGet() {
  const mod = await import('@/app/api/health/route');
  return mod.GET;
}

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    executeMock.mockReset();
    warnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares itself dynamic so the response is never prerendered', async () => {
    const mod = await import('@/app/api/health/route');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('200 {"status":"ok"} with Cache-Control: no-store when select 1 answers', async () => {
    executeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    const GET = await loadGet();

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(OK_BODY);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('503 {"status":"degraded"} when the query throws, logging the error class only', async () => {
    executeMock.mockRejectedValueOnce(new Error('secret-message-xyz host=db.internal'));
    const GET = await loadGet();

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(DEGRADED_BODY);
    expect(warnMock).toHaveBeenCalledWith({ err: 'Error', route: 'api.health' }, 'health.degraded');
    expect(JSON.stringify(warnMock.mock.calls)).not.toContain('secret-message-xyz');
  });

  it('503 when execute throws synchronously', async () => {
    executeMock.mockImplementationOnce(() => {
      throw new TypeError('boom');
    });
    const GET = await loadGet();

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe(DEGRADED_BODY);
  });

  it('503 after exactly 3 s when the query never answers', async () => {
    executeMock.mockReturnValueOnce(new Promise(() => {}));
    const GET = await loadGet();

    let settled = false;
    const pending = GET().then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(DEGRADED_BODY);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the result for 10 s, then probes again', async () => {
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const GET = await loadGet();

    expect((await GET()).status).toBe(200);
    await vi.advanceTimersByTimeAsync(9_999);
    expect((await GET()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    expect((await GET()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('caches a degraded result too, so a failing database is not hammered', async () => {
    executeMock.mockRejectedValueOnce(new Error('down'));
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const GET = await loadGet();

    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(503);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_001);
    expect((await GET()).status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('N concurrent requests run one query (single-flight)', async () => {
    let resolveQuery: (v: unknown) => void = () => {};
    executeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const GET = await loadGet();

    const pending = Array.from({ length: 10 }, () => GET());
    resolveQuery([{ '?column?': 1 }]);
    const responses = await Promise.all(pending);

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(new Set(bodies)).toEqual(new Set([OK_BODY]));
  });
});
