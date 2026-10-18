/**
 * `scripts/ci-neon-key-scope.ts` — the M3 key-scope proof (PR #586 review,
 * the security sign-off condition), two-sided and fail-closed:
 *   (i)  GET /projects is non-200 (a project-scoped key cannot list), OR 200
 *        with exactly one project whose id is NEON_CI_PROJECT_ID;
 *   (ii) GET /projects/{NEON_CI_PROJECT_ID} is 200 with that id.
 * Every other combination fails, and nothing printed carries the key.
 */
import { describe, expect, it } from 'vitest';
import { checkKeyScope, keyScopeVerdict, type ScopeResponse } from '../../../scripts/ci-neon-key-scope';

const CI = 'shy-dust-02766400';
const PROD = 'prod-project-111111';
const KEY = 'napi_secret_key_value_never_printed';

const res = (status: number, body: unknown): ScopeResponse => ({ status, body });

describe('keyScopeVerdict', () => {
  const ownProject = res(200, { project: { id: CI } });

  it('accepts a project-scoped key: the listing is refused, the CI project opens', () => {
    expect(keyScopeVerdict(res(404, {}), ownProject, CI)).toEqual({ ok: true, reason: expect.stringMatching(/scoped/) });
    expect(keyScopeVerdict(res(403, {}), ownProject, CI).ok).toBe(true);
  });

  it('accepts a listing of exactly the CI project when the CI project opens', () => {
    expect(keyScopeVerdict(res(200, { projects: [{ id: CI }] }), ownProject, CI).ok).toBe(true);
  });

  it('refuses an org-wide key whose listing holds more than the CI project', () => {
    const verdict = keyScopeVerdict(res(200, { projects: [{ id: CI }, { id: PROD }] }), ownProject, CI);
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/2 project/) });
  });

  it('refuses a listing of one project that is not the CI project', () => {
    expect(keyScopeVerdict(res(200, { projects: [{ id: PROD }] }), ownProject, CI).ok).toBe(false);
  });

  it('refuses a 200 listing whose body has no projects array', () => {
    expect(keyScopeVerdict(res(200, { nope: true }), ownProject, CI).ok).toBe(false);
  });

  it.each([500, 429, 503, 401, 302])(
    'refuses a listing that answers %i: only 404 (or 403) means a project-scoped key',
    (status) => {
      expect(keyScopeVerdict(res(status, {}), ownProject, CI).ok).toBe(false);
    },
  );

  it('refuses a wrong key: the CI project does not open (leg ii)', () => {
    expect(keyScopeVerdict(res(404, {}), res(404, {}), CI).ok).toBe(false);
    expect(keyScopeVerdict(res(401, {}), res(401, {}), CI).ok).toBe(false);
  });

  it('refuses when the project endpoint answers 200 for another id', () => {
    expect(keyScopeVerdict(res(404, {}), res(200, { project: { id: PROD } }), CI).ok).toBe(false);
  });

  it('refuses an empty CI project id outright', () => {
    expect(keyScopeVerdict(res(404, {}), ownProject, '').ok).toBe(false);
  });
});

describe('checkKeyScope', () => {
  function fakeFetch(routes: Record<string, ScopeResponse>) {
    const calls: Array<{ url: string; auth: string | null; signal: unknown }> = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
      calls.push({ url, auth: init?.headers?.Authorization ?? null, signal: init?.signal });
      const r = routes[url] ?? res(500, {});
      return { status: r.status, json: async () => r.body };
    };
    return { calls, fetchImpl };
  }

  const LIST = 'https://console.neon.tech/api/v2/projects';
  const ONE = `https://console.neon.tech/api/v2/projects/${CI}`;

  it('calls both legs with the key as a bearer and prints neither the key nor a body', async () => {
    const { calls, fetchImpl } = fakeFetch({ [LIST]: res(404, {}), [ONE]: res(200, { project: { id: CI } }) });
    const lines: string[] = [];
    const ok = await checkKeyScope({ apiKey: KEY, projectId: CI, fetchImpl, log: (l) => lines.push(l) });
    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([LIST, ONE]);
    expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    // Each request is bounded: a hung Neon API must not hang the job.
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).toMatch(/ok/);
  });

  it('fails an org-wide key and says only fail plus a count', async () => {
    const { fetchImpl } = fakeFetch({
      [LIST]: res(200, { projects: [{ id: CI }, { id: PROD }] }),
      [ONE]: res(200, { project: { id: CI } }),
    });
    const lines: string[] = [];
    expect(await checkKeyScope({ apiKey: KEY, projectId: CI, fetchImpl, log: (l) => lines.push(l) })).toBe(false);
    expect(lines.join('\n')).toMatch(/fail/);
    expect(lines.join('\n')).not.toContain(PROD);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('fails closed when a request throws', async () => {
    const fetchImpl = async () => {
      throw new Error(`network down for ${KEY}`);
    };
    const lines: string[] = [];
    expect(await checkKeyScope({ apiKey: KEY, projectId: CI, fetchImpl, log: (l) => lines.push(l) })).toBe(false);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('fails without calling Neon when the key or project id is missing', async () => {
    const { calls, fetchImpl } = fakeFetch({});
    expect(await checkKeyScope({ apiKey: '', projectId: CI, fetchImpl, log: () => {} })).toBe(false);
    expect(await checkKeyScope({ apiKey: KEY, projectId: '', fetchImpl, log: () => {} })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails closed when a request times out', async () => {
    const fetchImpl = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const lines: string[] = [];
    expect(await checkKeyScope({ apiKey: KEY, projectId: CI, fetchImpl, log: (l) => lines.push(l) })).toBe(false);
    expect(lines.join('\n')).toMatch(/TimeoutError/);
  });
});
