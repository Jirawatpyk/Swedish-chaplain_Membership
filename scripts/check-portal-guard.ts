#!/usr/bin/env tsx
/**
 * 059-membership-suspension Task 7 — `check:portal-guard` CI gate.
 *
 * Thin CLI wrapper: collects real repo file sources and delegates the
 * actual pass/fail logic to `scripts/lib/portal-guard-core.ts` (pure,
 * unit-tested in `tests/unit/scripts/check-portal-guard.test.ts`). See that
 * module's docstring for the full rationale + the current exemption list.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CHOKEPOINT_SYMBOL,
  EXEMPT_ROUTES,
  PAGE_CHOKEPOINT_SYMBOL,
  findRoutesMissingChokepoint,
  layoutHasPageChokepoint,
} from './lib/portal-guard-core';

const API_PORTAL_ROOT = 'src/app/api/portal';
const PORTAL_LAYOUT = 'src/app/(member)/portal/layout.tsx';

function toPosixRelative(absPath: string): string {
  return relative(process.cwd(), absPath).split('\\').join('/');
}

function collectRouteSources(): Map<string, string> {
  const out = new Map<string, string>();
  const entries = readdirSync(resolve(API_PORTAL_ROOT), {
    recursive: true,
    withFileTypes: true,
  });
  for (const e of entries) {
    if (!e.isFile() || e.name !== 'route.ts') continue;
    // Node 20.12+/22 exposes `parentPath`; older typings only have `path`.
    const parent =
      (e as { parentPath?: string; path?: string }).parentPath ??
      (e as { path: string }).path;
    const abs = resolve(join(parent, e.name));
    out.set(toPosixRelative(abs), readFileSync(abs, 'utf8'));
  }
  return out;
}

function main(): void {
  const routeSources = collectRouteSources();
  if (routeSources.size === 0) {
    console.error(
      `check:portal-guard — no route.ts files matched under ${API_PORTAL_ROOT}. Check the glob root.`,
    );
    process.exit(2);
    return;
  }

  const missing = findRoutesMissingChokepoint(routeSources, EXEMPT_ROUTES, CHOKEPOINT_SYMBOL);

  let layoutSource: string;
  try {
    layoutSource = readFileSync(resolve(PORTAL_LAYOUT), 'utf8');
  } catch {
    console.error(`check:portal-guard — ${PORTAL_LAYOUT} not found. Check the path.`);
    process.exit(2);
    return;
  }
  const layoutOk = layoutHasPageChokepoint(layoutSource, PAGE_CHOKEPOINT_SYMBOL);

  if (missing.length > 0 || !layoutOk) {
    console.error('check:portal-guard — portal access-gate coverage FAILED.\n');
    if (missing.length > 0) {
      console.error(
        `${missing.length} /api/portal/** route(s) do not reference ${CHOKEPOINT_SYMBOL}:`,
      );
      for (const m of missing) console.error(`  ${m}`);
      console.error(
        `\nEvery src/app/api/portal/**/route.ts must call ${CHOKEPOINT_SYMBOL} ` +
          '(src/lib/member-context.ts), or be added to EXEMPT_ROUTES in ' +
          'scripts/lib/portal-guard-core.ts with a documented, accurate reason.',
      );
    }
    if (!layoutOk) {
      console.error(`\n${PORTAL_LAYOUT} does not reference ${PAGE_CHOKEPOINT_SYMBOL}.`);
      console.error(
        `The member portal layout must call ${PAGE_CHOKEPOINT_SYMBOL} ` +
          "(src/lib/portal-page-access.ts) after requireSession('member') so a " +
          'terminated/suspended member is redirected on SSR load.',
      );
    }
    process.exit(1);
    return;
  }

  console.log(
    `check:portal-guard — OK (${routeSources.size} route(s) scanned, ` +
      `${EXEMPT_ROUTES.length} documented exemption(s), layout chokepoint present).`,
  );
}

const invokedDirectly =
  (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) ||
  process.argv[1]?.endsWith('check-portal-guard.ts') === true ||
  process.argv[1]?.endsWith('check-portal-guard.js') === true;

if (invokedDirectly) {
  main();
}
