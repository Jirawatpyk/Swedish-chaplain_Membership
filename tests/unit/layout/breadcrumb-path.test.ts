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

  it('drops the leading "admin" portal-root segment', () => {
    // Per the SaaS-convention filter (Stripe / Linear / GitHub /
    // Notion all skip the workspace/dashboard prefix in breadcrumb),
    // the leading `admin` segment is filtered from the parsed output.
    // Hrefs for the surviving segments still include `/admin/`
    // because they were reconstructed BEFORE the filter ran — only
    // the visible label is dropped.
    const result = parseBreadcrumbPath({
      pathname: '/admin/plans',
      staticLabels,
      dynamicLabels: new Map(),
    });

    expect(result).toEqual([
      {
        href: '/admin/plans',
        segment: 'plans',
        label: 'Plans',
        isCurrent: true,
        isLinkable: true,
      },
    ]);
  });

  it('drops "admin" + resolves dynamic segment labels for the rest', () => {
    const dynamicLabels = new Map([['abc123', 'Corporate Gold']]);

    const result = parseBreadcrumbPath({
      pathname: '/admin/plans/2026/abc123',
      staticLabels,
      dynamicLabels,
    });

    expect(result.map((s) => s.label)).toEqual([
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

  it('builds cumulative href per segment (after dropping admin prefix)', () => {
    const result = parseBreadcrumbPath({
      pathname: '/admin/settings/fees',
      staticLabels,
      dynamicLabels: new Map(),
    });

    // `admin` filtered; remaining hrefs still rooted at `/admin/...`
    // because hrefs are computed pre-filter.
    expect(result.map((s) => s.href)).toEqual([
      '/admin/settings',
      '/admin/settings/fees',
    ]);
  });

  it('resolves /admin/settings/broadcasts via STATIC_LABEL_KEYS', () => {
    // F7.1a US2 — broadcast settings entered STATIC_LABEL_KEYS in
    // breadcrumb-nav.tsx; this asserts the slug resolves correctly via
    // the auto-derivation pipeline (label + cumulative href + isCurrent
    // on the leaf segment). Future rename of the slug would break this
    // test loudly instead of silently shipping a raw "broadcasts" label.
    const result = parseBreadcrumbPath({
      pathname: '/admin/settings/broadcasts',
      staticLabels: { ...staticLabels, broadcasts: 'Broadcasts' },
      dynamicLabels: new Map(),
    });
    expect(result.map((s) => s.label)).toEqual(['Settings', 'Broadcasts']);
    expect(result.map((s) => s.href)).toEqual([
      '/admin/settings',
      '/admin/settings/broadcasts',
    ]);
    expect(result.at(-1)?.isCurrent).toBe(true);
  });

  it('marks structural segments non-linkable on the F6 erase deep-route (subtree cascade)', () => {
    // `/admin/events/<id>/registrations/<id>/erase` has a page.tsx only at
    // the `erase` leaf. Both `registrations` and the UUID `registrationId`
    // beneath it lack an index page, so they must render as non-linkable
    // plain text — otherwise the prefetch of those crumb links 404s
    // (the bug this guards). The leaf is the real current route.
    const eventId = 'c348fa6f-ee2b-4ee7-b13b-49b8ddc6fb18';
    const regId = '71cb2941-366e-4e8b-97c8-551d8d79f2b4';
    const result = parseBreadcrumbPath({
      pathname: `/admin/events/${eventId}/registrations/${regId}/erase`,
      staticLabels: {
        ...staticLabels,
        events: 'Events',
        erase: 'Erase personal data',
      },
      dynamicLabels: new Map(),
    });

    // `admin` dropped → [events, <eventId>, registrations, <regId>, erase]
    expect(result.map((s) => s.segment)).toEqual([
      'events',
      eventId,
      'registrations',
      regId,
      'erase',
    ]);
    const seg = (s: string) => result.find((r) => r.segment === s)!;
    expect(seg('events').isLinkable).toBe(true); // real list route
    expect(seg(eventId).isLinkable).toBe(true); // real event-detail route
    expect(seg('registrations').isLinkable).toBe(false); // structural opener
    expect(seg(regId).isLinkable).toBe(false); // cascaded structural child
    expect(seg('erase').isCurrent).toBe(true); // real current route
  });

  it('preserves percent-encoded href while decoding label', () => {
    const dynamicLabels = new Map([['กรุงเทพ', 'Bangkok Chapter']]);
    // %E0%B8%81%E0%B8%A3%E0%B8%B8%E0%B8%87%E0%B9%80%E0%B8%97%E0%B8%9E = "กรุงเทพ"
    const result = parseBreadcrumbPath({
      pathname:
        '/admin/plans/%E0%B8%81%E0%B8%A3%E0%B8%B8%E0%B8%87%E0%B9%80%E0%B8%97%E0%B8%9E',
      staticLabels,
      dynamicLabels,
    });
    const last = result.at(-1)!;
    expect(last.href).toBe(
      '/admin/plans/%E0%B8%81%E0%B8%A3%E0%B8%B8%E0%B8%87%E0%B9%80%E0%B8%97%E0%B8%9E',
    );
    expect(last.segment).toBe('กรุงเทพ');
    expect(last.label).toBe('Bangkok Chapter');
  });

  it('treats consecutive slashes as a single separator', () => {
    // Empty segments from `//` are filtered out (`filter(p => p.length > 0)`).
    // Note: `admin` is also filtered out by the portal-root drop, so
    // the visible trail is just `[plans]`.
    const result = parseBreadcrumbPath({
      pathname: '/admin//plans',
      staticLabels,
      dynamicLabels: new Map(),
    });
    expect(result.map((s) => s.segment)).toEqual(['plans']);
  });

  it('strips the query string so label lookup still resolves', () => {
    // `parseBreadcrumbPath` defensively splits on `?`, so a caller
    // passing `window.location.pathname` (which may include a query)
    // still gets clean segments. Without this, `plans?year=2026` would
    // fall through static-label lookup and render the raw URL text.
    const result = parseBreadcrumbPath({
      pathname: '/admin/plans?year=2026',
      staticLabels,
      dynamicLabels: new Map(),
    });
    const last = result.at(-1)!;
    expect(last.segment).toBe('plans');
    expect(last.label).toBe('Plans');
    expect(last.href).toBe('/admin/plans');
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
    isLinkable: true,
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
