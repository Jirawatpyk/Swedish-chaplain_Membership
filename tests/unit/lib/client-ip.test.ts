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
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/client-ip';

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
