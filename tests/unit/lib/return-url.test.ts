/**
 * Unit tests for `safeReturnTo()` open-redirect guard (T171).
 *
 * The guard is the single trust boundary between an attacker-supplied
 * URL and `router.push`/`redirect()`. Every rejected case below
 * represents a known open-redirect attack pattern.
 */
import { describe, expect, it } from 'vitest';
import { buildSignInUrl, safeReturnTo } from '@/lib/return-url';

describe('safeReturnTo — accepts valid same-portal paths', () => {
  it('accepts the portal root', () => {
    expect(safeReturnTo('/admin', 'staff')).toBe('/admin');
    expect(safeReturnTo('/portal', 'member')).toBe('/portal');
  });

  it('accepts deeper staff paths', () => {
    expect(safeReturnTo('/admin/users', 'staff')).toBe('/admin/users');
    expect(safeReturnTo('/admin/users/123/edit', 'staff')).toBe('/admin/users/123/edit');
  });

  it('preserves query strings', () => {
    expect(safeReturnTo('/admin/users?page=2&sort=email', 'staff')).toBe(
      '/admin/users?page=2&sort=email',
    );
  });

  it('strips the fragment (server-side redirect drops it anyway)', () => {
    expect(safeReturnTo('/admin/users#section', 'staff')).toBe('/admin/users');
  });

  it('accepts deeper member paths', () => {
    expect(safeReturnTo('/portal/profile', 'member')).toBe('/portal/profile');
  });
});

describe('safeReturnTo — rejects non-string / malformed values', () => {
  it.each([
    [undefined],
    [null],
    [123],
    [true],
    [{}],
    [[]],
    [['/admin', '/admin/users']],
  ])('rejects %p', (input) => {
    expect(safeReturnTo(input, 'staff')).toBeNull();
  });

  it('rejects the empty string', () => {
    expect(safeReturnTo('', 'staff')).toBeNull();
  });

  it('rejects paths exceeding 512 chars', () => {
    const long = '/admin/' + 'a'.repeat(520);
    expect(safeReturnTo(long, 'staff')).toBeNull();
  });
});

describe('safeReturnTo — rejects open-redirect attack patterns', () => {
  it('rejects absolute URLs (http://evil)', () => {
    expect(safeReturnTo('http://evil.example/admin', 'staff')).toBeNull();
    expect(safeReturnTo('https://evil.example/admin', 'staff')).toBeNull();
  });

  it('rejects protocol-relative URLs (//evil)', () => {
    expect(safeReturnTo('//evil.example/admin', 'staff')).toBeNull();
    expect(safeReturnTo('//evil.example', 'staff')).toBeNull();
  });

  it('rejects URLs containing a scheme anywhere', () => {
    expect(safeReturnTo('/admin/https://evil', 'staff')).toBeNull();
    expect(safeReturnTo('/admin?next=http://evil', 'staff')).toBeNull();
  });

  it('rejects backslash + CRLF injection (header smuggling)', () => {
    expect(safeReturnTo('/admin\\evil', 'staff')).toBeNull();
    expect(safeReturnTo('/admin\nSet-Cookie: a=b', 'staff')).toBeNull();
    expect(safeReturnTo('/admin\r\nLocation: http://evil', 'staff')).toBeNull();
  });

  it('rejects paths that do not start with /', () => {
    expect(safeReturnTo('admin/users', 'staff')).toBeNull();
    expect(safeReturnTo('javascript:alert(1)', 'staff')).toBeNull();
  });
});

describe('safeReturnTo — portal boundary enforcement', () => {
  it('rejects staff paths when portal=member', () => {
    expect(safeReturnTo('/admin', 'member')).toBeNull();
    expect(safeReturnTo('/admin/users', 'member')).toBeNull();
  });

  it('rejects member paths when portal=staff', () => {
    expect(safeReturnTo('/portal', 'staff')).toBeNull();
    expect(safeReturnTo('/portal/profile', 'staff')).toBeNull();
  });

  it('rejects unrelated paths in either portal', () => {
    expect(safeReturnTo('/random', 'staff')).toBeNull();
    expect(safeReturnTo('/admindashboard', 'staff')).toBeNull(); // not /admin or /admin/...
    expect(safeReturnTo('/portalx', 'member')).toBeNull();
  });
});

describe('safeReturnTo — rejects paths that loop back to the auth flow', () => {
  it('rejects sign-in / forgot / reset / invite pages', () => {
    expect(safeReturnTo('/admin/sign-in', 'staff')).toBeNull();
    expect(safeReturnTo('/admin/sign-in?x=1', 'staff')).toBeNull();
    expect(safeReturnTo('/portal/sign-in', 'member')).toBeNull();
    expect(safeReturnTo('/forgot-password', 'staff')).toBeNull();
    expect(safeReturnTo('/reset-password/abc', 'staff')).toBeNull();
    expect(safeReturnTo('/invite/xyz', 'staff')).toBeNull();
  });

  it('rejects any path under /api/', () => {
    expect(safeReturnTo('/api/auth/sign-in', 'staff')).toBeNull();
  });
});

describe('buildSignInUrl', () => {
  it('returns the bare sign-in URL when fromPath is null', () => {
    expect(buildSignInUrl('staff', null)).toBe('/admin/sign-in');
    expect(buildSignInUrl('member', null)).toBe('/portal/sign-in');
  });

  it('returns the bare sign-in URL when fromPath is unsafe', () => {
    expect(buildSignInUrl('staff', 'http://evil.example')).toBe('/admin/sign-in');
    expect(buildSignInUrl('staff', '/portal/profile')).toBe('/admin/sign-in');
  });

  it('appends returnTo when fromPath is a valid same-portal path', () => {
    expect(buildSignInUrl('staff', '/admin/users')).toBe(
      '/admin/sign-in?returnTo=%2Fadmin%2Fusers',
    );
  });

  it('URI-encodes the returnTo value', () => {
    expect(buildSignInUrl('staff', '/admin/users?page=2&sort=email')).toBe(
      '/admin/sign-in?returnTo=%2Fadmin%2Fusers%3Fpage%3D2%26sort%3Demail',
    );
  });

  it('strips sign-in self-reference (no loop)', () => {
    expect(buildSignInUrl('staff', '/admin/sign-in')).toBe('/admin/sign-in');
  });
});
