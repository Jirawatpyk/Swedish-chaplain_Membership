/**
 * `portalHomePath` + `portalSignInPath` unit test.
 *
 * Pure ternary helpers (2 branches each), but they're called from 6
 * sites across the auth flow. A path swap ('/admin' ↔ '/portal')
 * would silently misdirect every post-auth redirect — the R6 folder
 * rename rationale in the file comment explicitly calls out these
 * pinned assertions as "the safety net that makes the rename safe".
 */
import { describe, expect, it } from 'vitest';
import { portalHomePath, portalSignInPath } from '@/lib/portal-paths';

describe('portalHomePath', () => {
  it('returns /admin for staff', () => {
    expect(portalHomePath('staff')).toBe('/admin');
  });

  it('returns /portal for member', () => {
    expect(portalHomePath('member')).toBe('/portal');
  });
});

describe('portalSignInPath', () => {
  it('returns /admin/sign-in for staff', () => {
    expect(portalSignInPath('staff')).toBe('/admin/sign-in');
  });

  it('returns /portal/sign-in for member', () => {
    expect(portalSignInPath('member')).toBe('/portal/sign-in');
  });
});
