import { describe, expect, it } from 'vitest';

import {
  parseBreadcrumbPath,
  truncateForMobile,
} from '@/components/layout/breadcrumb-path';

describe('parseBreadcrumbPath', () => {
  const staticLabels = {
    admin: 'Admin',
    plans: 'Plans',
    users: 'Users',
    settings: 'Settings',
    fees: 'Fee Configuration',
    new: 'New Plan',
    clone: 'Clone Plan',
    edit: 'Edit',
  };

  it('parses root path as empty list', () => {
    expect(
      parseBreadcrumbPath({
        pathname: '/',
        staticLabels,
        dynamicLabels: new Map(),
      }),
    ).toEqual([]);
  });

  it('resolves static segment labels from i18n map', () => {
    const result = parseBreadcrumbPath({
      pathname: '/admin/plans',
      staticLabels,
      dynamicLabels: new Map(),
    });

    expect(result).toEqual([
      { href: '/admin', segment: 'admin', label: 'Admin', isCurrent: false },
      { href: '/admin/plans', segment: 'plans', label: 'Plans', isCurrent: true },
    ]);
  });

  it('resolves dynamic segment labels from provider map', () => {
    const dynamicLabels = new Map([['abc123', 'Corporate Gold']]);

    const result = parseBreadcrumbPath({
      pathname: '/admin/plans/2026/abc123',
      staticLabels,
      dynamicLabels,
    });

    expect(result.map((s) => s.label)).toEqual([
      'Admin',
      'Plans',
      '2026',
      'Corporate Gold',
    ]);
    expect(result.at(-1)?.isCurrent).toBe(true);
  });

  it('falls back to raw slug when label missing', () => {
    const result = parseBreadcrumbPath({
      pathname: '/admin/plans/unknown-slug',
      staticLabels,
      dynamicLabels: new Map(),
    });

    expect(result.at(-1)?.label).toBe('unknown-slug');
  });

  it('builds cumulative href per segment', () => {
    const result = parseBreadcrumbPath({
      pathname: '/admin/settings/fees',
      staticLabels,
      dynamicLabels: new Map(),
    });

    expect(result.map((s) => s.href)).toEqual([
      '/admin',
      '/admin/settings',
      '/admin/settings/fees',
    ]);
  });

  it('ignores trailing slash', () => {
    const withSlash = parseBreadcrumbPath({
      pathname: '/admin/plans/',
      staticLabels,
      dynamicLabels: new Map(),
    });
    const withoutSlash = parseBreadcrumbPath({
      pathname: '/admin/plans',
      staticLabels,
      dynamicLabels: new Map(),
    });
    expect(withSlash).toEqual(withoutSlash);
  });
});

describe('truncateForMobile', () => {
  const mk = (segment: string, label: string, isCurrent = false) => ({
    href: `/x/${segment}`,
    segment,
    label,
    ...(isCurrent ? { isCurrent: true as const } : { isCurrent: false as const }),
  });

  it('returns all segments with hasEllipsis=false when <=2 segments', () => {
    expect(truncateForMobile([])).toEqual({ visible: [], hasEllipsis: false });

    const one = [mk('admin', 'Admin', true)];
    expect(truncateForMobile(one)).toEqual({ visible: one, hasEllipsis: false });

    const two = [mk('admin', 'Admin'), mk('users', 'Users', true)];
    expect(truncateForMobile(two)).toEqual({ visible: two, hasEllipsis: false });
  });

  it('shows parent + current + ellipsis when >2 segments', () => {
    const trail = [
      mk('admin', 'Admin'),
      mk('plans', 'Plans'),
      mk('2026', '2026'),
      mk('abc', 'Corporate Gold', true),
    ];
    const result = truncateForMobile(trail);
    expect(result.visible.map((s) => s.label)).toEqual(['2026', 'Corporate Gold']);
    expect(result.hasEllipsis).toBe(true);
  });

  it('3-segment trail shows ellipsis + last 2', () => {
    const trail = [
      mk('admin', 'Admin'),
      mk('settings', 'Settings'),
      mk('fees', 'Fee Configuration', true),
    ];
    const result = truncateForMobile(trail);
    expect(result.visible.map((s) => s.label)).toEqual([
      'Settings',
      'Fee Configuration',
    ]);
    expect(result.hasEllipsis).toBe(true);
  });
});
