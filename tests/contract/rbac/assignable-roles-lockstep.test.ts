/**
 * Contract: `ASSIGNABLE_ROLES` ↔ the server-side role zod enums must stay in
 * lockstep (016-rbac-permissions; review 016 PR1 conv-1 / type-7 / test-3).
 *
 * `ASSIGNABLE_ROLES` restricts what the invite dialog OFFERS. The authoritative
 * gate is the server: `POST /api/auth/invite` and `POST /api/auth/users/[id]/role`
 * each carry a zod enum. A UI-only restriction with a permissive API would be a
 * privilege-escalation path, and a widened UI with a stale API is a dead option.
 * PR 3 (super_admin) and PR 4 (marketing) widen all three together — this test
 * fails loudly if one moves without the others.
 *
 * The schemas are re-declared here rather than exported from the route modules:
 * importing a route pulls the whole Next.js server graph into the unit runner.
 * The literal is kept in sync by the source-text assertions below, which read
 * the real route files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ASSIGNABLE_ROLES, isStaffRole, ROLES } from '@/modules/auth/domain/role';
import { CHANGE_ROLE_OPTIONS } from '@/components/auth/change-role-dialog';
import { stripCommentsPreserveLines } from '../../../scripts/lib/source-scan';

const ROUTES = [
  {
    label: 'invite',
    prop: 'role',
    path: join('src', 'app', 'api', 'auth', 'invite', 'route.ts'),
  },
  {
    label: 'change-role',
    prop: 'newRole',
    path: join('src', 'app', 'api', 'auth', 'users', '[id]', 'role', 'route.ts'),
  },
];

/** The users-page role filter — the FOURTH list. See the test at the bottom. */
const FILTERS_PATH = join('src', 'components', 'auth', 'users-filters.tsx');

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * The role literals of `<prop>: z.enum([...])`, read from CODE only.
 *
 * Keyed on the property name rather than "the first `z.enum` in the file", and
 * run over comment-stripped source. Both changes close holes the whole-file
 * regex had, and they are not hypothetical — the review demonstrated each one
 * by mutation:
 *
 *  - COMMENTS WERE SOURCE. `source.match(/z\.enum\(\[...\]\)/)` reads raw text,
 *    so a comment spelling out the full list above a NARROWED real enum passed
 *    silently, as did the reverse (a real enum WIDER than ASSIGNABLE_ROLES —
 *    the privilege-escalation direction). The route file carried a NOTE saying
 *    "this must stay the FIRST z.enum in the file", which is an invitation to
 *    write exactly that comment. Removed along with the fragility.
 *  - ORDER WAS LOAD-BEARING. `locale: z.enum(['en','th','sv'])` sits two lines
 *    below `role:` in the invite route. Moving it up turned this contract into
 *    an assertion about locales.
 *
 * Throws on zero or multiple matches — mirrors `extractPageGuard` in
 * `scripts/lib/source-scan.ts`, where silently taking the first is precisely
 * how a docblock got compared against production config.
 */
function roleEnumValues(source: string, prop: string): string[] {
  const code = stripCommentsPreserveLines(source);
  const re = new RegExp(String.raw`\b${prop}:\s*z\.enum\(\[([^\]]*)\]\)`, 'g');
  const matches = [...code.matchAll(re)];
  if (matches.length === 0) throw new Error(`no \`${prop}: z.enum([...])\` found in code`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} \`${prop}: z.enum([...])\` declarations — expected one`);
  }
  return [...matches[0]![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * The right-hand side of `const ROLE_VALUES = …` in the users-page filter bar,
 * read from CODE only. Returns the literal role strings when it is hand-written
 * and `null` when it is derived from the domain union (the shape that cannot
 * drift, and so the shape this contract wants to see).
 */
function filterRoleDeclaration(source: string): { literals: string[] | null; text: string } {
  const code = stripCommentsPreserveLines(source);
  const match = code.match(/const ROLE_VALUES = ([^;]+);/);
  if (!match?.[1]) throw new Error('no `const ROLE_VALUES = …` found in code');
  const text = match[1].trim();
  if (!text.startsWith('[')) return { literals: null, text };
  return { literals: [...text.matchAll(/'([^']+)'/g)].map((m) => m[1] as string), text };
}

describe('ASSIGNABLE_ROLES ↔ server role enums (lockstep)', () => {
  it.each(ROUTES)('$label route accepts exactly ASSIGNABLE_ROLES', ({ path, prop }) => {
    const values = roleEnumValues(read(path), prop);
    expect([...values].sort()).toEqual([...ASSIGNABLE_ROLES].sort());
  });

  it.each(ROUTES)('$label route rejects every not-yet-assignable role', ({ path, prop }) => {
    const values = roleEnumValues(read(path), prop);
    const schema = z.enum(values as [string, ...string[]]);
    const notAssignable = ROLES.filter((r) => !ASSIGNABLE_ROLES.includes(r));

    // PR 4 closed the staging window — every role is assignable now, so this set
    // is empty and the loop below is vacuous. Kept deliberately: it is the guard
    // that catches a FUTURE role added to ROLES without a decision about whether
    // it may be assigned. When that happens this test starts doing work again.
    expect(notAssignable).toEqual([]);
    for (const role of notAssignable) {
      expect(schema.safeParse(role).success, `${role} must be rejected`).toBe(false);
    }
  });

  /**
   * The THIRD list, which this file did not cover until PR 4.
   *
   * `CHANGE_ROLE_OPTIONS` (change-role-dialog.tsx) is what the users-page picker
   * actually renders. It sat outside the lockstep, so a role could become
   * assignable at the API while remaining unofferable in the UI — or worse, the
   * reverse. It is deliberately NOT equal to ASSIGNABLE_ROLES: `member` is
   * excluded because moving someone between the staff and member portals is a
   * different operation from re-ranking a staff member, and the route rejects it
   * with `role-portal-mismatch` anyway.
   *
   * The invariant is therefore `ASSIGNABLE_ROLES ∩ STAFF_ROLES`, which stays
   * correct automatically as roles are added.
   */
  it('CHANGE_ROLE_OPTIONS is exactly the assignable STAFF roles', () => {
    const expected = ASSIGNABLE_ROLES.filter((r) => isStaffRole(r));
    expect([...CHANGE_ROLE_OPTIONS].sort()).toEqual([...expected].sort());
    expect(CHANGE_ROLE_OPTIONS, 'member is a portal move, not a staff re-rank').not.toContain(
      'member',
    );
    expect(CHANGE_ROLE_OPTIONS).toContain('marketing');
  });

  /**
   * The FOURTH list — the one the comment in `invite/route.ts` claimed was
   * covered while it was not.
   *
   * `ROLE_VALUES` in `users-filters.tsx` populates the Role dropdown on the very
   * page that assigns roles. It shipped as `['admin','manager','member']` and
   * neither PR 3 (`super_admin`) nor PR 4 (`marketing`) touched it, so the page
   * could MINT a role it could not then FILTER for — and "who holds super_admin
   * right now?", the single most important question this screen answers, had no
   * way to be asked. `page.tsx` validates `?role=` against all of `ROLES`, so
   * the URL accepted values the UI never offered and no radio matched.
   *
   * This is the same shadow-copy class as the other three: a role union
   * re-typed as literals somewhere `Record<Role, …>` cannot reach it. Filtering
   * is unrelated to ASSIGNABLE_ROLES — you filter for what EXISTS, including
   * roles no longer handed out — so the invariant is the full `ROLES`.
   */
  it('the users-page role FILTER offers every role that can exist', () => {
    const { literals, text } = filterRoleDeclaration(read(FILTERS_PATH));
    if (literals === null) {
      // Derived from the domain union — drift is now a type error, not a bug
      // this test has to notice. That is the outcome this contract wants.
      expect(text, `ROLE_VALUES must derive from ROLES, got \`${text}\``).toMatch(/\bROLES\b/);
      return;
    }
    expect([...literals].sort(), 'a role you can assign but cannot filter for is invisible').toEqual(
      [...ROLES].sort(),
    );
  });
});

/**
 * Self-tests. A source-reading contract is only as good as its extractor, and
 * this one was demonstrably foolable — the assertions above cannot detect that
 * about themselves.
 */
describe('the extractor reads code, not prose', () => {
  it('ignores a full role list spelled out in a comment above a narrowed enum', () => {
    const src = [
      "// Keep in lockstep: 'super_admin', 'admin', 'manager', 'member', 'marketing'",
      "  role: z.enum(['member']),",
    ].join('\n');
    expect(roleEnumValues(src, 'role')).toEqual(['member']);
  });

  it('ignores a block comment quoting the enum', () => {
    const src = ["/** role: z.enum(['admin']) */", "  role: z.enum(['member', 'manager']),"].join(
      '\n',
    );
    expect(roleEnumValues(src, 'role')).toEqual(['member', 'manager']);
  });

  it('is not fooled by declaration ORDER — it keys on the property', () => {
    const src = ["  locale: z.enum(['en', 'th', 'sv']),", "  role: z.enum(['admin']),"].join('\n');
    expect(roleEnumValues(src, 'role')).toEqual(['admin']);
  });

  it('THROWS on two declarations of the same property rather than taking the first', () => {
    const src = ["  role: z.enum(['admin']),", "  role: z.enum(['member']),"].join('\n');
    expect(() => roleEnumValues(src, 'role')).toThrow(/expected one/);
  });

  it('THROWS when the property is absent instead of reporting an empty list', () => {
    expect(() => roleEnumValues("locale: z.enum(['en'])", 'role')).toThrow(/no `role/);
  });

  it('reads ROLE_VALUES from code, not from a comment', () => {
    const src = [
      "// const ROLE_VALUES = ['super_admin', 'admin', 'manager', 'member', 'marketing'];",
      "const ROLE_VALUES = ['admin'] as const;",
    ].join('\n');
    expect(filterRoleDeclaration(src).literals).toEqual(['admin']);
  });

  it('reports a DERIVED ROLE_VALUES as literal-free rather than as an empty list', () => {
    // An extractor that returned `[]` here would compare [] against ROLES and
    // fail on the correct code, pushing the next author back to a literal.
    const { literals, text } = filterRoleDeclaration('const ROLE_VALUES = byDisplayOrder(ROLES);');
    expect(literals).toBeNull();
    expect(text).toBe('byDisplayOrder(ROLES)');
  });
});
