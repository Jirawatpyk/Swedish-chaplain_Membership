/**
 * 016 review — the `/admin/settings` index is filtered by permission, and each
 * card mirrors the guard on the page it links to.
 *
 * T064 named this file and was marked complete without it being touched. The
 * miss was live on the ON leg: the index admits anyone with `dashboard.view`,
 * so `marketing` opened it and saw two cards that both 404, and a plain admin
 * saw the invoicing card D4 had moved to super-admin-only. Every such click
 * also writes a `permission_denied` row to an append-only audit log for a user
 * who did nothing wrong.
 *
 * Parses the page source rather than importing it: the page is an async Server
 * Component whose import chain pulls the session and tenant readers, and the
 * property under test is the DECLARATION, not the render. Same technique, and
 * same shared scanner, as the nav and palette parity suites.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractPageGuard } from '../../../../../scripts/lib/source-scan';
import { canPerform } from '@/lib/rbac';
import { ROLES, type Role } from '@/modules/auth/domain/role';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

const REPO_ROOT = process.cwd();
const INDEX_FILE = join(REPO_ROOT, 'src/app/(staff)/admin/settings/page.tsx');

interface Category {
  readonly href: string;
  readonly permission: PermissionKey;
  /** Feature-flag dimension, same vocabulary as `nav.ts` (`NavVisibilityFlag`). */
  readonly visibilityFlag?: string;
}

/** The `CATEGORIES` array as declared in the page source. */
function parseCategories(): readonly Category[] {
  const src = readFileSync(INDEX_FILE, 'utf8');
  const start = src.indexOf('const CATEGORIES = [');
  expect(start, 'CATEGORIES not found in the settings index').toBeGreaterThan(-1);
  const end = src.indexOf('] as const;', start);
  const body = src.slice(start, end);
  const out: Category[] = [];
  for (const block of body.match(/\{[^{}]*\}/g) ?? []) {
    const href = /href: '([^']+)'/.exec(block);
    const permission = /permission: '([^']+)'/.exec(block);
    // Hard failure, not `continue`: a card the parser cannot read is a card
    // this suite is not checking, and silence there is how the palette parser
    // was found to be dropping entries.
    expect(href, `unparsed CATEGORIES entry: ${block}`).not.toBeNull();
    expect(permission, `${href?.[1]} declares no permission`).not.toBeNull();
    const visibilityFlag = /visibilityFlag: '([^']+)'/.exec(block);
    out.push({
      href: href![1]!,
      permission: permission![1] as PermissionKey,
      ...(visibilityFlag ? { visibilityFlag: visibilityFlag[1]! } : {}),
    });
  }
  return out;
}

const CATEGORIES = parseCategories();

describe('settings index declares a permission per card', () => {
  it('parses the known cards (the parser actually walked)', () => {
    // 4 since the 016 post-ship review closed the 2-of-4 sidebar-parity gap
    // (broadcasts + eventcreate cards, both feature-flag-aware); 5 with the
    // F114 US6 member-change approval card (flag-aware too).
    expect(CATEGORIES).toHaveLength(5);
  });

  it('the page still filters — `visible` is derived, not the raw list', () => {
    const src = readFileSync(INDEX_FILE, 'utf8');
    // The filter body now carries the visibilityFlag arm BEFORE canPerform;
    // both dimensions must be present.
    expect(src).toMatch(/CATEGORIES\.filter\(/);
    expect(src).toMatch(/visibilityFlag/);
    expect(src).toMatch(/canPerform\(user\.role, c\.permission\)/);
    // …and the render maps the FILTERED list. A filter computed and then not
    // used is the likeliest way this regresses.
    expect(src).toMatch(/\{visible\.map\(/);
    expect(src).not.toMatch(/\{CATEGORIES\.map\(/);
  });
});

describe('each card mirrors its destination page guard', () => {
  it.each(CATEGORIES.map((c) => [c.href, c] as const))('%s', (href, card) => {
    const rel = href.replace(/^\/admin\/?/, '');
    const file = join(REPO_ROOT, `src/app/(staff)/admin/${rel}/page.tsx`);
    expect(existsSync(file), `no page file for ${href}`).toBe(true);
    const guard = extractPageGuard(readFileSync(file, 'utf8'), file);
    expect(guard, `${file} declares no guard`).not.toBeNull();
    expect(card.permission).toBe(guard!.key);
  });
});

describe('ON-leg visibility per role', () => {
  function visibleFor(role: Role): readonly string[] {
    return CATEGORIES.filter((c) =>
      canPerform(role, c.permission),
    ).map((c) => c.href);
  }

  it('marketing sees NO card — it would otherwise be offered two dead ends', () => {
    expect(visibleFor('marketing')).toEqual([]);
  });

  it('a plain admin loses only the D4-narrowed invoicing card', () => {
    const visible = visibleFor('admin');
    expect(visible).not.toContain('/admin/settings/invoicing');
    expect(visible).toContain('/admin/settings/renewals/schedules');
    expect(visible).toContain('/admin/settings/broadcasts');
    expect(visible).toContain('/admin/settings/integrations/eventcreate');
  });

  it('super_admin sees every card', () => {
    expect(visibleFor('super_admin')).toHaveLength(CATEGORIES.length);
  });

  it('every role sees only cards it can actually open', () => {
    // The property, stated once over the whole matrix rather than per role.
    for (const role of ROLES) {
      for (const href of visibleFor(role)) {
        const card = CATEGORIES.find((c) => c.href === href)!;
        expect(
          canPerform(role, card.permission),
          `${role} is offered ${href} but cannot open it`,
        ).toBe(true);
      }
    }
  });
});

describe('F114 US6 — the member-change approval card (permission + flag dimensions)', () => {
  const HREF = '/admin/settings/member-changes';
  /** The page's own filter, both dimensions, over the parsed declaration. */
  function visibleFor(role: Role, flags: Readonly<Record<string, boolean>>): readonly string[] {
    return CATEGORIES.filter(
      (c) =>
        !(c.visibilityFlag !== undefined && !flags[c.visibilityFlag]) &&
        canPerform(role, c.permission),
    ).map((c) => c.href);
  }
  const ALL_ON = { broadcastsEnabled: true, eventsEnabled: true, memberChangeApproval: true };

  it('is declared with members.write and gated on the memberChangeApproval flag', () => {
    const card = CATEGORIES.find((c) => c.href === HREF);
    expect(card).toBeDefined();
    expect(card!.permission).toBe('members.write');
    expect(card!.visibilityFlag).toBe('memberChangeApproval');
    // …and the page resolves that flag name (a flag the page never sets
    // would hide the card forever — the closed-union safety nav.ts has).
    expect(readFileSync(INDEX_FILE, 'utf8')).toMatch(/memberChangeApproval: env\.features\.memberChangeApproval/);
  });

  it('is listed for admin with the flag on', () => {
    expect(visibleFor('admin', ALL_ON)).toContain(HREF);
  });

  it('is absent for manager (no members.write) even with the flag on', () => {
    expect(visibleFor('manager', ALL_ON)).not.toContain(HREF);
  });

  it('is absent with the flag off even for admin (FR-039 — the page 404s)', () => {
    expect(visibleFor('admin', { ...ALL_ON, memberChangeApproval: false })).not.toContain(HREF);
  });
});
