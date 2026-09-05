/**
 * 016 T064 (US3) — every command-palette entry is gated by a permission, and
 * that permission is never looser than the guard on the page it jumps to.
 *
 * Replaces `filter-results-by-role.test.ts`, which tested a CLIENT-side mirror
 * of the server's role filter. That mirror is gone: it could only restate a
 * role→visibility mapping, and once the server started filtering per entry
 * against each destination's declared permission, no client copy could
 * reproduce it (`canPerform` reads `env`, absent from that bundle). What the
 * mirror actually did on the ON leg was blank the palette for `marketing`.
 *
 * Two properties, both derived from SOURCE rather than a fixture:
 *
 *  1. NAVIGATE entries mirror their destination page's guard exactly — a
 *     navigate entry is nothing but a jump, so a different key is either a dead
 *     end or a hidden door.
 *  2. ACTION entries may be STRICTER than their destination (they express a
 *     write intent on a page that only requires read — "Record payment" lands
 *     on the invoice list), but never looser. Expressed as a subset check over
 *     what the real evaluator answers, so it keeps holding as bundles change.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { extractPageGuard } from '../../../../scripts/lib/source-scan';
import { join } from 'node:path';
import { ROLES, type Role } from '@/modules/auth/domain/role';
import { canPerform } from '@/lib/rbac';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

const REPO_ROOT = process.cwd();
const REGISTRY_FILE = join(
  REPO_ROOT,
  'src/modules/plans/application/search-plans.ts',
);

type Entry = {
  readonly id: string;
  readonly url: string;
  readonly permission: PermissionKey;
  readonly kind: 'action' | 'navigate';
};

/**
 * Parse the two registries out of the source rather than importing them: they
 * are module-private, and exporting them purely for a test would widen the
 * module's surface to make the test easier — which is how the surface ends up
 * used in production.
 */
function parseRegistries(): readonly Entry[] {
  const src = readFileSync(REGISTRY_FILE, 'utf8');
  const out: Entry[] = [];
  for (const [name, kind] of [
    ['ACTION_REGISTRY', 'action'],
    ['NAVIGATE_REGISTRY', 'navigate'],
  ] as const) {
    const start = src.indexOf(`const ${name}: `);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const open = src.indexOf('[', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '[') depth += 1;
      else if (src[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(open, end);
    // Innermost-brace match: an entry that grows a nested object (`feature: {…}`)
    // would be split and its outer half would carry no `id`. The original code
    // `continue`d on that, so the entry silently left the checked set while the
    // count floor still passed. It is a hard failure now — a palette entry this
    // parser cannot read is an entry nothing is checking.
    for (const block of body.match(/\{[^{}]*\}/g) ?? []) {
      const id = /id: ['"]([^'"]+)['"]/.exec(block);
      const url = /url: ['"]([^'"]+)['"]/.exec(block);
      const permission = /permission: '([^']+)'/.exec(block);
      // A fragment with neither id nor url is the outer half of a split entry,
      // or the `as const` tail — those are expected. One with an id but no url
      // (or vice versa) is a real entry the parser mangled.
      if (!id && !url) continue;
      expect(id, `entry fragment has a url but no id: ${block}`).not.toBeNull();
      expect(url, `entry ${id?.[1]} has no url`).not.toBeNull();
      expect(permission, `${id?.[1]} has no permission`).not.toBeNull();
      out.push({
        id: id![1]!,
        url: url![1]!,
        permission: permission![1] as PermissionKey,
        kind,
      });
    }
  }
  return out;
}

/** The guard on the page a palette url lands on (query string ignored). */
function pageGuardFor(url: string): { key: string } | null {
  const path = url.split('?')[0]!;
  const rel = path.replace(/^\/admin\/?/, '');
  const file = join(
    REPO_ROOT,
    rel === ''
      ? 'src/app/(staff)/admin/(home)/page.tsx'
      : `src/app/(staff)/admin/${rel}/page.tsx`,
  );
  if (!existsSync(file)) return null;
  // Shared scanner: the local version stripped only whole-line `//`, so a
  // `requirePagePermission(...)` example inside a page's JSDoc header matched
  // before the real call. See scripts/lib/source-scan.ts.
  return extractPageGuard(readFileSync(file, 'utf8'), file);
}

/**
 * Roles that hold `key` on the ON leg, answered by the REAL evaluator.
 *
 * NOT `ROLE_BUNDLES[role].has(key)`: `super_admin` and `admin` share one bundle
 * and the super-admin-only keys are granted by the evaluator, not the map. A
 * bundle lookup therefore reports `audit.read` as held by NOBODY — which is how
 * the first draft of this test managed to fail on correct config.
 */
function holders(key: string): ReadonlySet<Role> {
  return new Set(
    ROLES.filter((r) =>
      canPerform(r, key as PermissionKey),
    ),
  );
}

const ENTRIES = parseRegistries();

describe('palette registries declare a permission (T064)', () => {
  it('parses EXACTLY the known entry count', () => {
    // Pinned, not a floor. `>= 30` against 32 real entries let two disappear
    // unnoticed — and the entries likeliest to grow a nested field, and so to
    // be dropped by the innermost-brace parser, are the newest ones. Update
    // deliberately when the palette gains or loses an entry.
    // 108 PR-D: +1 — `nav.marketingAudience`.
    expect(ENTRIES).toHaveLength(33);
  });

  it('no entry still carries the two-tier `requires` tag', () => {
    // Strip comments first: the docblock explaining WHY the two-tier tag was
    // replaced quotes it verbatim, and a raw source scan would read that prose
    // as a live tag. (Same class as the commented-out-guard trap.)
    const src = readFileSync(REGISTRY_FILE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/requires: '(admin|read)'/);
  });

  it('entry ids are unique across both registries', () => {
    const ids = ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('navigate entries mirror their destination page guard (T064)', () => {
  const NAV = ENTRIES.filter((e) => e.kind === 'navigate');

  it.each(NAV.map((e) => [e.id, e] as const))('%s', (_id, entry) => {
    const guard = pageGuardFor(entry.url);
    expect(guard, `no page guard found for ${entry.url}`).not.toBeNull();
    expect(entry.permission).toBe(guard!.key);
  });
});

describe('action entries are never looser than their destination (T064)', () => {
  const ACTIONS = ENTRIES.filter((e) => e.kind === 'action');

  it.each(ACTIONS.map((e) => [e.id, e] as const))('%s', (_id, entry) => {
    const guard = pageGuardFor(entry.url);
    expect(guard, `no page guard found for ${entry.url}`).not.toBeNull();
    const entryHolders = holders(entry.permission);
    const pageHolders = holders(guard!.key);
    // Subset, not equality: an action MAY require more than the page it lands
    // on. Anyone the action admits must at minimum be able to open that page,
    // or the entry is an invitation to a 404.
    for (const role of entryHolders) {
      expect(
        pageHolders.has(role),
        `${entry.id} admits ${role}, who cannot open ${entry.url}`,
      ).toBe(true);
    }
    // …and the action must actually admit somebody, or it is dead config.
    expect(entryHolders.size).toBeGreaterThan(0);
  });
});

describe('ON-leg palette reach per role (T064)', () => {
  function reachable(role: Role): readonly string[] {
    return ENTRIES.filter((e) =>
      canPerform(role, e.permission),
    ).map((e) => e.id);
  }

  it('marketing reaches its own surfaces — the palette is no longer blank for it', () => {
    // The bug this task closes: the old `requires` filter's final arm returned
    // [] for every role that was neither administrator nor manager, so a
    // marketing operator's Ctrl+K showed nothing at all.
    const ids = reachable('marketing');
    expect(ids).toContain('nav.dashboard');
    expect(ids).toContain('nav.members');
    expect(ids).toContain('nav.broadcasts');
    expect(ids).toContain('nav.events');
    expect(ids).toContain('broadcast.review');
  });

  it('marketing reaches nothing on a money, audit or settings surface', () => {
    const ids = reachable('marketing');
    for (const denied of [
      'invoice.new',
      'invoice.recordPayment',
      'invoice.rerenderReceipt',
      'refund.issue',
      'nav.invoices',
      'nav.creditNotes',
      'nav.invoiceSettings',
      'nav.users',
      'nav.auditLog',
      'audit.view',
      'nav.plans',
      'plan.new',
    ]) {
      expect(ids, `${denied} must be out of marketing's palette`).not.toContain(denied);
    }
  });

  it('member reaches nothing at all', () => {
    expect(reachable('member')).toEqual([]);
  });

  it('super_admin reaches every entry', () => {
    expect(reachable('super_admin')).toHaveLength(ENTRIES.length);
  });

  it('manager keeps its read surfaces and no write action', () => {
    const ids = reachable('manager');
    expect(ids).toContain('nav.invoices');
    expect(ids).toContain('nav.renewals');
    expect(ids).not.toContain('invoice.new');
    expect(ids).not.toContain('refund.issue');
    expect(ids).not.toContain('plan.new');
  });
});
