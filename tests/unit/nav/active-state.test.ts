import { describe, expect, it } from 'vitest';

import { findActivePattern, isNavItemActive } from '@/config/nav';

describe('isNavItemActive', () => {
  describe('exact match (exact: prefix)', () => {
    it('matches exact pathname', () => {
      expect(isNavItemActive('/admin', 'exact:/admin')).toBe(true);
    });

    it('does not match sub-paths', () => {
      expect(isNavItemActive('/admin/plans', 'exact:/admin')).toBe(false);
    });

    it('does not match partial paths', () => {
      expect(isNavItemActive('/admin/', 'exact:/admin')).toBe(false);
    });
  });

  describe('prefix match', () => {
    it('matches exact pathname', () => {
      expect(isNavItemActive('/admin/plans', '/admin/plans')).toBe(true);
    });

    it('matches sub-paths', () => {
      expect(isNavItemActive('/admin/plans/2026/abc123', '/admin/plans')).toBe(true);
    });

    it('does not match unrelated paths', () => {
      expect(isNavItemActive('/admin/users', '/admin/plans')).toBe(false);
    });

    it('does not match partial prefix (no slash boundary)', () => {
      expect(isNavItemActive('/admin/planning', '/admin/plan')).toBe(false);
    });
  });

  describe('Dashboard edge case', () => {
    it('Dashboard (exact:/admin) is active only on /admin', () => {
      expect(isNavItemActive('/admin', 'exact:/admin')).toBe(true);
    });

    it('Dashboard is NOT active on /admin/plans', () => {
      expect(isNavItemActive('/admin/plans', 'exact:/admin')).toBe(false);
    });

    it('Dashboard is NOT active on /admin/users', () => {
      expect(isNavItemActive('/admin/users', 'exact:/admin')).toBe(false);
    });

    it('Dashboard is NOT active on /admin/settings/fees', () => {
      expect(isNavItemActive('/admin/settings/fees', 'exact:/admin')).toBe(false);
    });
  });

  describe('Settings sub-page', () => {
    it('/admin/settings/fees matches /admin/settings/fees', () => {
      expect(isNavItemActive('/admin/settings/fees', '/admin/settings/fees')).toBe(true);
    });

    it('/admin/settings/fees matches /admin/settings (parent group)', () => {
      expect(isNavItemActive('/admin/settings/fees', '/admin/settings')).toBe(true);
    });
  });
});

describe('findActivePattern (deepest match wins)', () => {
  const patterns = [
    'exact:/admin',
    '/admin/plans',
    '/admin/users',
    '/admin/settings',
    '/admin/settings/fees',
  ];

  it('returns exact Dashboard for /admin', () => {
    expect(findActivePattern('/admin', patterns)).toBe('exact:/admin');
  });

  it('returns /admin/plans for /admin/plans/2026/abc', () => {
    expect(findActivePattern('/admin/plans/2026/abc', patterns)).toBe('/admin/plans');
  });

  it('returns /admin/settings/fees for /admin/settings/fees (deepest)', () => {
    expect(findActivePattern('/admin/settings/fees', patterns)).toBe('/admin/settings/fees');
  });

  it('returns /admin/settings for /admin/settings/general (unknown sub)', () => {
    expect(findActivePattern('/admin/settings/general', patterns)).toBe('/admin/settings');
  });

  it('returns null for /admin/unknown', () => {
    expect(findActivePattern('/admin/unknown', patterns)).toBeNull();
  });

  it('returns null for completely unrelated path', () => {
    expect(findActivePattern('/portal', patterns)).toBeNull();
  });

  it('exact: pattern uses path length (not raw string length) for tie-breaking', () => {
    // 'exact:/admin' raw length = 12, '/admin/plans' raw length = 12
    // Only '/admin/plans' matches /admin/plans (exact:/admin does NOT match)
    expect(findActivePattern('/admin/plans', ['exact:/admin', '/admin/plans'])).toBe('/admin/plans');
    // Only exact:/admin matches /admin
    expect(findActivePattern('/admin', ['exact:/admin', '/admin/plans'])).toBe('exact:/admin');
  });

  it('prefix pattern wins over shorter exact pattern for sub-paths', () => {
    expect(findActivePattern('/admin/settings/fees', ['exact:/admin', '/admin/settings'])).toBe('/admin/settings');
  });
});
