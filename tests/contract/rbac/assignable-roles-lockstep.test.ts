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

import { ASSIGNABLE_ROLES, ROLES } from '@/modules/auth/domain/role';

const ROUTES = [
  { label: 'invite', path: join('src', 'app', 'api', 'auth', 'invite', 'route.ts') },
  {
    label: 'change-role',
    path: join('src', 'app', 'api', 'auth', 'users', '[id]', 'role', 'route.ts'),
  },
];

/** Extracts the string literals of the first `z.enum([...])` in a source file. */
function firstZodEnumValues(source: string): string[] {
  const match = source.match(/z\.enum\(\[([^\]]*)\]\)/);
  if (!match?.[1]) throw new Error('no z.enum([...]) found');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('ASSIGNABLE_ROLES ↔ server role enums (lockstep)', () => {
  it.each(ROUTES)('$label route accepts exactly ASSIGNABLE_ROLES', ({ path }) => {
    const values = firstZodEnumValues(readFileSync(join(process.cwd(), path), 'utf8'));
    expect([...values].sort()).toEqual([...ASSIGNABLE_ROLES].sort());
  });

  it.each(ROUTES)('$label route rejects every not-yet-assignable role', ({ path }) => {
    const values = firstZodEnumValues(readFileSync(join(process.cwd(), path), 'utf8'));
    const schema = z.enum(values as [string, ...string[]]);
    const notAssignable = ROLES.filter((r) => !ASSIGNABLE_ROLES.includes(r));

    // PR 3 widened super_admin into ASSIGNABLE_ROLES (and both route enums);
    // only marketing stays gated until PR 4.
    expect(notAssignable).not.toContain('super_admin');
    expect(notAssignable).toEqual(expect.arrayContaining(['marketing']));
    for (const role of notAssignable) {
      expect(schema.safeParse(role).success, `${role} must be rejected`).toBe(false);
    }
  });
});
