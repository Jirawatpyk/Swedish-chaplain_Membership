/**
 * 016 T061/T063 (US3) — the staff sidebar is filtered by PERMISSION, and every
 * entry's permission matches the guard on the page it links to.
 *
 * Two failure modes this closes:
 *  - a nav entry stricter than its page → the feature exists but is unreachable
 *    from the sidebar for someone entitled to it (silent, nobody reports it);
 *  - a nav entry looser than its page → a link that lands on a 403/notFound,
 *    which is what the `roles: ['admin','super_admin']` arrays were manually
 *    approximating for three items and getting wrong for the other eleven the
 *    moment `marketing` became assignable.
 *
 * The parity check reads BOTH SOURCES — the nav config's declared key and the
 * `requirePagePermission(...)` call in the target page file. A fixture listing
 * the expected pairs would pass forever after either side changed; this cannot.
 * (Same lesson as `check-staff-page-guard.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { extractPageGuard } from '../../../scripts/lib/source-scan';
import { join } from 'node:path';
import {
  staffNavConfig,
  filterNavConfig,
  flattenNavItems,
  type NavItem,
} from '@/config/nav';
import { staffNavAllowedHrefs } from '@/lib/nav-permissions';

const REPO_ROOT = process.cwd();

/** `/admin/settings/invoicing` → the page file that renders it. */
function pageFileFor(href: string): string | null {
  const rel = href.replace(/^\/admin\/?/, '');
  const candidates =
    rel === ''
      ? ['src/app/(staff)/admin/(home)/page.tsx']
      : [
          `src/app/(staff)/admin/${rel}/page.tsx`,
          `src/app/(staff)/admin/(home)/${rel}/page.tsx`,
        ];
  for (const c of candidates) {
    const abs = join(REPO_ROOT, c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * The `requirePagePermission('key', legacyRow)` a page declares.
 *
 * Delegates to the shared scanner. The version written here first stripped only
 * whole-line `//`, so the `requirePagePermission(...)` EXAMPLE inside
 * `admin/compliance/erasure-log/page.tsx`'s JSDoc header matched before the real
 * call 116 lines below — this suite was comparing nav config against prose, on
 * the highest-PII surface in the product, and passing for the wrong reason.
 */
function guardOf(file: string): { key: string; legacy: string } | null {
  return extractPageGuard(readFileSync(file, 'utf8'), file);
}

const STAFF_ITEMS: readonly NavItem[] = flattenNavItems(staffNavConfig);

describe('staff nav declares a permission for every entry (T061)', () => {
  it('finds EXACTLY the known staff item count (the flattener actually walked)', () => {
    // Pinned, not a floor. A floor of >=14 against 16 real items let two
    // disappear unnoticed, and a flattener that returned [] would make every
    // other test in this file pass vacuously. Update deliberately when the
    // sidebar gains or loses an entry.
    expect(STAFF_ITEMS).toHaveLength(16);
  });

  it('every staff nav item declares a guard', () => {
    // The key and the row now travel as ONE `SurfaceGuard`, so "declared half"
    // is no longer representable — this only has to catch "declared none",
    // which for a staff item means it is visible to every role.
    const missing = STAFF_ITEMS.filter((i) => !i.guard).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it('staff hrefs are unique', () => {
    // `filterNavConfig` gates on `allowedHrefs.has(item.href)`, so two items
    // sharing an href would let the LOOSER one unlock the stricter one. The
    // docblock on `staffNavAllowedHrefs` claimed this was asserted here; it was
    // not — the claim was written for the palette suite and never made true for
    // nav.
    const hrefs = STAFF_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size, `duplicate href in staffNavConfig: ${hrefs}`).toBe(hrefs.length);
  });

  it('no staff nav item still uses the legacy `roles` array', () => {
    // The arrays were a hand-maintained approximation of three pages' guards.
    // Leaving one behind would mean that item is filtered by BOTH mechanisms,
    // and the stricter one silently wins.
    const stragglers = STAFF_ITEMS.filter((i) => i.roles).map((i) => i.href);
    expect(stragglers).toEqual([]);
  });

  /**
   * The assertions above walk `flattenNavItems`, which returns LEAVES. A
   * `NavGroup` node is not among them, so it escapes both the guard check and
   * the legacy-`roles` check — and a group carries a visible label. It has no
   * href, and it only renders when at least one child survives, so the exposure
   * is a section title rather than a link; that is why this is separate rather
   * than folded into "every staff nav item declares a guard".
   *
   * `staffNavConfig` has no groups today, which is precisely why this needs
   * asserting: the first one added would otherwise arrive unchecked.
   */
  it('no staff nav GROUP carries a legacy roles array (groups escape the leaf walk)', () => {
    const groups = staffNavConfig.sections.flatMap((s) =>
      s.items.filter((i): i is Extract<typeof i, { children: unknown }> => 'children' in i),
    );
    const withRoles = groups.filter((g) => g.roles).map((g) => g.titleKey);
    expect(withRoles, 'a group hidden by `roles` is invisible to the permission model').toEqual([]);
  });

  it('staff titleKeys are unique', () => {
    // `titleKey` is the React key for section items (staff-sidebar.tsx), and
    // `href` for group children (nav-item.tsx). A duplicate is a reconciliation
    // bug rather than a permission one, but it costs one line beside the href
    // uniqueness assertion that already exists.
    const keys = staffNavConfig.sections.flatMap((s) => s.items.map((i) => i.titleKey));
    expect(new Set(keys).size, `duplicate titleKey: ${keys}`).toBe(keys.length);
  });
});

describe('every staff nav entry matches its target page guard (T063)', () => {
  it.each(STAFF_ITEMS.map((i) => [i.href, i] as const))(
    '%s',
    (href, item) => {
      const file = pageFileFor(href);
      expect(file, `no page file found for ${href}`).not.toBeNull();
      const guard = guardOf(file!);
      expect(guard, `${file} has no requirePagePermission call`).not.toBeNull();
      // Presence is asserted by the T061 suite above; narrow here so a missing
      // guard surfaces as that suite's failure rather than a confusing TS error.
      expect(item.guard).toBeDefined();
      expect(item.guard!.key).toBe(guard!.key);
      expect(item.guard!.legacy.kind).toBe(
        // `legacySessionOnly` → kind 'legacySessionOnly', etc. The nav stores
        // the row VALUE; the page names the imported const. Comparing the kind
        // to the identifier keeps the two in step without importing the page.
        guard!.legacy,
      );
    },
  );
});

describe('filterNavConfig filters on the server-computed allow-list (T063)', () => {
  const ALL_FLAGS = { broadcastsEnabled: true, eventsEnabled: true };

  function hrefsFor(allowed: readonly string[] | undefined): readonly string[] {
    const filtered = filterNavConfig(
      staffNavConfig,
      ALL_FLAGS,
      'admin',
      allowed === undefined ? undefined : new Set(allowed),
    );
    return flattenNavItems(filtered).map((i) => i.href);
  }

  it('keeps exactly the allowed hrefs', () => {
    const allowed = ['/admin', '/admin/members', '/admin/broadcasts'];
    expect([...hrefsFor(allowed)].sort()).toEqual([...allowed].sort());
  });

  it('drops an item whose href is absent from the allow-list', () => {
    expect(hrefsFor(['/admin'])).not.toContain('/admin/invoices');
  });

  it('drops EVERY permissioned item when no allow-list is supplied (fail-closed)', () => {
    // A caller that forgets to thread the allow-list must render an empty
    // sidebar, not the full one. The opposite default turns one missed wiring
    // into every staff link being visible to every role.
    expect(hrefsFor(undefined)).toEqual([]);
  });

  it('drops a section left with no visible items (no orphan header)', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      ALL_FLAGS,
      'admin',
      new Set(['/admin']),
    );
    // Only the dashboard survives → exactly one section remains.
    expect(filtered.sections).toHaveLength(1);
  });

  it('still honours visibilityFlag on top of the allow-list', () => {
    const filtered = filterNavConfig(
      staffNavConfig,
      { broadcastsEnabled: false, eventsEnabled: true },
      'admin',
      new Set(['/admin', '/admin/broadcasts', '/admin/events']),
    );
    const hrefs = flattenNavItems(filtered).map((i) => i.href);
    // Permitted by RBAC but the kill-switch is off — the link would 503.
    expect(hrefs).not.toContain('/admin/broadcasts');
    expect(hrefs).toContain('/admin/events');
  });
});

/**
 * 016 T063 — the ON-leg sidebar per role, resolved through the REAL evaluator.
 *
 * These lists are the point of the whole task: before it, `filterNavConfig`
 * consulted three hand-maintained `roles` arrays, so `marketing` (which passes
 * none of them and is named by none) saw every entry without an array — every
 * invoice, credit-note, plan, renewal and settings link on the staff sidebar.
 */
describe('ON-leg sidebar per role (T063)', () => {
  const ALL_FLAGS = { broadcastsEnabled: true, eventsEnabled: true };

  function sidebarFor(role: Parameters<typeof staffNavAllowedHrefs>[0]): readonly string[] {
    return flattenNavItems(
      filterNavConfig(
        staffNavConfig,
        ALL_FLAGS,
        role,
        new Set(staffNavAllowedHrefs(role, { rbacV2: true })),
      ),
    ).map((i) => i.href);
  }

  it('marketing sees exactly its bundle — engagement + member read, no money', () => {
    // Frozen literal, ordered as the sidebar renders. Anything appearing here
    // that marketing's bundle does not carry is a leak; anything missing that
    // it does carry is a feature it cannot reach.
    expect(sidebarFor('marketing')).toEqual([
      '/admin',
      '/admin/members',
      '/admin/broadcasts',
      '/admin/events',
    ]);
  });

  it('marketing sees NO money, compliance, user-admin or settings surface', () => {
    const hrefs = sidebarFor('marketing');
    for (const denied of [
      '/admin/invoices',
      '/admin/credit-notes',
      '/admin/renewals',
      '/admin/plans',
      '/admin/directory',
      '/admin/users',
      '/admin/audit',
      '/admin/compliance/erasure-log',
      '/admin/settings/invoicing',
      '/admin/settings/renewals/schedules',
      '/admin/settings/broadcasts',
      '/admin/settings/integrations/eventcreate',
    ]) {
      expect(hrefs, `${denied} must not be in the marketing sidebar`).not.toContain(denied);
    }
  });

  it('super_admin sees every entry', () => {
    expect(sidebarFor('super_admin')).toHaveLength(STAFF_ITEMS.length);
  });

  it('D4 hides the narrowed surfaces from a plain admin', () => {
    const hrefs = sidebarFor('admin');
    // These four moved to super_admin-only. Leaving them visible would send an
    // admin to a page their own guard denies — the same dead-link class the
    // activity feed's audit link had (T058).
    expect(hrefs).not.toContain('/admin/users');
    expect(hrefs).not.toContain('/admin/audit');
    expect(hrefs).not.toContain('/admin/settings/invoicing');
    expect(hrefs).not.toContain('/admin/compliance/erasure-log');
    // …and the rest of the admin's surface is untouched.
    expect(hrefs).toContain('/admin/invoices');
    expect(hrefs).toContain('/admin/members');
  });

  it('manager keeps its read-only surface and loses nothing it could open before', () => {
    const hrefs = sidebarFor('manager');
    expect(hrefs).toContain('/admin/invoices');
    expect(hrefs).toContain('/admin/renewals');
    expect(hrefs).toContain('/admin/plans');
    expect(hrefs).not.toContain('/admin/compliance/erasure-log');
  });
});
