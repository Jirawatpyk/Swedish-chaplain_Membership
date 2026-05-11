/**
 * getClientIp() unit test.
 *
 * The helper keys the per-IP rate limit bucket for 9 auth routes. A
 * parsing bug (off-by-one on `split`, wrong fallback precedence,
 * trimming failure) would cause rate-limit keys to collide on
 * `0.0.0.0` in certain proxy configurations, silently disabling
 * per-IP limiting — directly undermining T-01 (credential stuffing)
 * and T-16 (argon2 DoS) defences.
 *
 * This test pins the decision matrix:
 *   - `x-forwarded-for` with single entry → that entry
 *   - `x-forwarded-for` with CSV → first entry (nearest client)
 *   - `x-forwarded-for` with leading/trailing whitespace → trimmed
 *   - no XFF, `x-real-ip` present → x-real-ip
 *   - neither header → `'0.0.0.0'` sentinel
 *   - empty XFF string → fall through to x-real-ip
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  assertVercelDeploymentForTrustedXff,
  getClientIp,
} from '@/lib/client-ip';

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers,
  });
}

describe('getClientIp() — proxy-header parser', () => {
  it('returns a single x-forwarded-for entry as-is', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('returns the FIRST entry when x-forwarded-for is comma-separated', () => {
    // The nearest client is leftmost (Vercel sets it that way).
    const req = makeRequest({
      'x-forwarded-for': '203.0.113.5, 10.0.0.1, 172.16.0.1',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('trims leading whitespace inside a comma-separated XFF entry', () => {
    const req = makeRequest({ 'x-forwarded-for': '  203.0.113.5  ,10.0.0.1' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = makeRequest({ 'x-real-ip': '198.51.100.7' });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('returns the 0.0.0.0 sentinel when neither header is present', () => {
    const req = makeRequest({});
    expect(getClientIp(req)).toBe('0.0.0.0');
  });

  it('prefers x-forwarded-for over x-real-ip when both are set', () => {
    const req = makeRequest({
      'x-forwarded-for': '203.0.113.5',
      'x-real-ip': '198.51.100.7',
    });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('falls through to x-real-ip when x-forwarded-for is an empty string', () => {
    // Empty XFF should not be treated as a valid IP. The current impl
    // relies on `xff` truthy check — empty string is falsy in JS, so
    // this case is covered, but it's worth pinning.
    const req = makeRequest({
      'x-forwarded-for': '',
      'x-real-ip': '198.51.100.7',
    });
    expect(getClientIp(req)).toBe('198.51.100.7');
  });

  it('returns the sentinel when x-forwarded-for is a single comma (malformed)', () => {
    // Malformed XFF "," yields `['', '']` → first entry empty → falls
    // through to x-real-ip → 0.0.0.0 sentinel. This is defensive
    // behaviour against a broken upstream proxy.
    const req = makeRequest({ 'x-forwarded-for': ',' });
    expect(getClientIp(req)).toBe('0.0.0.0');
  });
});

/**
 * K14-10 (R13-S11) — assertVercelDeploymentForTrustedXff() boot-time
 * diagnostic. The function gates the only mitigation for SEC-R12-1
 * (XFF spoofing on off-Vercel deployments). All branches must fire
 * exactly when intended; a regression that silences the warning
 * silently re-opens the spoofing attack surface on production.
 *
 * Branches under test:
 *   1. NODE_ENV !== 'production' → no-warn (dev/test exits early).
 *   2. Vercel + production → no-warn (platform handles XFF).
 *   3. Off-Vercel + production + TRUSTED_REVERSE_PROXY=true → no-warn
 *      (operator acknowledged trusted proxy).
 *   4. Off-Vercel + production + no opt-out → console.warn fires.
 *   5. Off-Vercel + production + TRUSTED_REVERSE_PROXY="True"
 *      (capitalised) → no-warn (booleanFromString coerces correctly).
 */
describe('assertVercelDeploymentForTrustedXff() — boot-time XFF trust diagnostic', () => {
  // Snapshot env vars we mutate so each test is isolated.
  const ORIG_NODE_ENV = process.env.NODE_ENV;
  const ORIG_VERCEL = process.env.VERCEL;
  const ORIG_TRP = process.env.TRUSTED_REVERSE_PROXY;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The lazy-import in the function caches via Node's module cache; we
    // need to reset it between tests so the new env values are re-read
    // by the zod schema parser.
    vi.resetModules();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    // K15-6 (R14-S5): use vi.stubEnv consistently for all 3 env vars
    // (was mixed manual `process.env.X = ORIG` + vi.stubEnv before).
    // vi.stubEnv with empty-string is the canonical "absent" signal —
    // matches how Vitest auto-restores stubs at end-of-test.
    vi.stubEnv('NODE_ENV', ORIG_NODE_ENV ?? 'test');
    vi.stubEnv('VERCEL', ORIG_VERCEL ?? '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', ORIG_TRP ?? '');
  });

  it('does NOT warn when NODE_ENV is not production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', '');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when deployed on Vercel (production)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', '');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when off-Vercel + TRUSTED_REVERSE_PROXY=true (production)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', 'true');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('WARNS when off-Vercel + no opt-out + production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', '');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/SEC-R12-1/);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/x-forwarded-for/);
  });

  it('K14-9 (R13-S6): does NOT warn when TRUSTED_REVERSE_PROXY is "True" (capitalised)', () => {
    // Pre-K14, raw `process.env.X === 'true'` would have failed this
    // case → spurious warning. Routing through booleanFromString in
    // env.ts schema makes capitalisation variants equivalent.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', 'True');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('K14-9 (R13-S6): does NOT warn when TRUSTED_REVERSE_PROXY is "1"', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TRUSTED_REVERSE_PROXY', '1');
    assertVercelDeploymentForTrustedXff();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
