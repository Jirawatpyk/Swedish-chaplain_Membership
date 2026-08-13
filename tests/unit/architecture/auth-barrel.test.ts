/**
 * 016 review I7 — machine-readable inventory of the auth deep-import carve-out.
 *
 * Constitution Principle III requires cross-module imports to go through a
 * module's public barrel, enforced by ESLint `no-restricted-imports`. The RBAC
 * v2 sweep deliberately deviates: 46 pages and ~119 API routes import their
 * legacy shim row directly from `@/modules/auth/domain/permissions/legacy-shim`,
 * and a handful of Application files import `isAdministrativeRole` /
 * `normalizeLegacyRole` from `@/modules/auth/domain/**` as VALUES. The reason is
 * recorded in `specs/016-rbac-permissions/plan.md` § Complexity Tracking #5:
 * the auth barrel is a value-import trapdoor onto `auth-deps`, which builds
 * argon2 / Upstash / repo singletons at module eval.
 *
 * Two reasons this test exists rather than a lint rule:
 *
 *  1. **The lint rule is already shadowed here.** `eslint.config.mjs` is flat
 *     config, where a later block REPLACES `no-restricted-imports` rather than
 *     merging it. The events-brand block near the end matches
 *     `src/**​/*.{ts,tsx}`, so for everything under `src/app/**` and
 *     `src/components/**` the cross-module barrel rule is not in force at all.
 *     A green `pnpm lint` is therefore silence, not approval — exactly the kind
 *     of "the guardrail outlived the guard" trap this repo has hit before.
 *  2. **PR 5 needs an exact deletion list.** The shim, the façade and the flag
 *     all go together; a count that can drift silently means the cleanup PR
 *     cannot know when it is done.
 *
 * The COUNT assertions are deliberate friction: widening the carve-out should
 * require a conscious edit here plus a note in Complexity Tracking #5.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/**
 * Specifiers under `@/modules/auth/**` that are NOT the public barrel — both
 * static `from '…'` and dynamic `import('…')` forms. The re-review proved the
 * static-only version was evadable (and already wrong): `src/lib/rbac.ts`
 * dynamic-imports the audit-repo, so the inventory under-counted by one and
 * converting any static import to `await import(...)` would have removed a
 * file from the count silently.
 */
const DEEP_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*)['"](@\/modules\/auth\/(?:domain|application|infrastructure)\/[^'"]+)['"]/g;

/**
 * Deep specifiers the carve-out permits. Everything here is pure Domain: no
 * framework imports, no infrastructure, safe in a client bundle.
 */
const ALLOWED = new Set([
  '@/modules/auth/domain/permissions/permission-catalogue',
  '@/modules/auth/domain/permissions/evaluator',
  // 016 review — added by PR 4's SurfaceGuard. `src/config/nav.ts` is pulled
  // into the CLIENT bundle by `staff-sidebar.tsx`, so it cannot import the auth
  // barrel: `auth-deps` builds argon2 / Upstash / repo singletons at module
  // eval. `surface-guard.ts` is pure Domain — two type-only imports and an
  // object literal, no runtime dependency at all.
  '@/modules/auth/domain/permissions/surface-guard',
  '@/modules/auth/domain/role',
  '@/modules/auth/domain/branded',
  '@/modules/auth/domain/user',
  '@/modules/auth/domain/session',
  '@/modules/auth/domain/audit-event',
]);

/**
 * Deep imports that reach PAST Domain (application / infrastructure). These
 * predate 016 entirely — cron routes pulling Drizzle tables from
 * `infrastructure/db/schema`, the `auth-deps` composition root wiring every use
 * case and repo. They are NOT part of the RBAC carve-out and this test does not
 * pretend 016 should fix them; it pins the CURRENT size so the 016 carve-out
 * cannot be used as cover to grow the older one.
 */
const NON_DOMAIN_BASELINE_FILES = 42;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly specifier: string;
}

const hits: Hit[] = [];
for (const file of walk(SRC)) {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/');
  // Files INSIDE the auth module import their own internals normally.
  if (rel.startsWith('src/modules/auth/')) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(DEEP_IMPORT_RE)) {
    hits.push({ file: rel, specifier: m[1]! });
  }
}

const isDomain = (specifier: string): boolean => specifier.startsWith('@/modules/auth/domain/');

describe('016 I7 — auth deep-import carve-out inventory', () => {
  it('every DOMAIN deep specifier is on the pure-Domain allow-list', () => {
    const unexpected = hits
      .filter((h) => isDomain(h.specifier) && !ALLOWED.has(h.specifier))
      .map((h) => `${h.file} -> ${h.specifier}`);
    expect(
      [...new Set(unexpected)].sort(),
      'A new deep import into @/modules/auth/domain appeared. If it is genuinely ' +
        'pure Domain and the barrel would drag infrastructure (auth-deps builds ' +
        'argon2 / Upstash / repo singletons at module eval), add it to ALLOWED and ' +
        'extend plan.md § Complexity Tracking #5. Otherwise import from the ' +
        '@/modules/auth barrel.',
    ).toEqual([]);
  });

  it('the deleted legacy shim has ZERO importers (PR 5 deletion is total)', () => {
    // This pin used to hold the deletion INVENTORY (>100 files, ceiling 135)
    // so PR 5 could count down without churn. PR 5 happened: the module is
    // gone, and the invariant inverts — any importer now is a resurrection,
    // which would also be a build error, but this fails with a message that
    // says WHY rather than a module-not-found stack.
    const shimFiles = new Set(
      hits
        .filter((h) => h.specifier === '@/modules/auth/domain/permissions/legacy-shim')
        .map((h) => h.file),
    );
    expect([...shimFiles], 'the legacy shim was deleted in PR 5 — nothing may import it').toEqual(
      [],
    );
  });

  it('the pre-016 non-Domain deep imports have not grown', () => {
    // Not a 016 concern and not asserted to zero — see NON_DOMAIN_BASELINE_FILES.
    // Pinned so the RBAC carve-out cannot be used as cover to add more.
    // 42 = the 41 static importers + src/lib/rbac.ts, whose infrastructure
    // reach is a DYNAMIC import the first regex could not see.
    const files = new Set(
      hits.filter((h) => !isDomain(h.specifier)).map((h) => h.file),
    );
    expect(files.size).toBeLessThanOrEqual(NON_DOMAIN_BASELINE_FILES);
  });
});
