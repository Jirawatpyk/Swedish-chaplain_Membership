/**
 * 059-membership-suspension Task 7 — `check:portal-guard` CI gate.
 *
 * Pure fixture tests against `scripts/lib/portal-guard-core.ts` (no real
 * filesystem I/O — the CLI wrapper `scripts/check-portal-guard.ts` is the
 * only piece that touches disk) plus a "production wiring" regression guard
 * that reads the REAL repo files and asserts they currently pass the gate.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CHOKEPOINT_SYMBOL,
  DIRECT_ACCESS_CHECK_SYMBOL,
  EXEMPT_ROUTES,
  PAGE_CHOKEPOINT_SYMBOL,
  findRoutesMissingChokepoint,
  layoutHasPageChokepoint,
} from '../../../scripts/lib/portal-guard-core';

describe('findRoutesMissingChokepoint', () => {
  it('fails a fixture route that does NOT reference requireMemberContext', () => {
    const routeSources = new Map<string, string>([
      [
        'src/app/api/portal/fixture-missing/route.ts',
        `import { NextResponse } from 'next/server';\n` +
          `export async function GET() { return NextResponse.json({ ok: true }); }`,
      ],
    ]);
    expect(findRoutesMissingChokepoint(routeSources, [])).toEqual([
      'src/app/api/portal/fixture-missing/route.ts',
    ]);
  });

  it('passes a fixture route that imports + calls requireMemberContext', () => {
    const routeSources = new Map<string, string>([
      [
        'src/app/api/portal/fixture-present/route.ts',
        `import { requireMemberContext } from '@/lib/member-context';\n` +
          `export async function GET(request) {\n` +
          `  const ctx = await requireMemberContext(request);\n` +
          `  if (ctx.response) return ctx.response;\n` +
          `}`,
      ],
    ]);
    expect(findRoutesMissingChokepoint(routeSources, [])).toEqual([]);
  });

  it('does not flag a route on the exemption list even without the chokepoint symbol', () => {
    const routeSources = new Map<string, string>([
      [
        'src/app/api/portal/public/route.ts',
        `export async function GET() { return new Response('ok'); }`,
      ],
    ]);
    const exempt = [{ path: 'src/app/api/portal/public/route.ts', reason: 'documented test exemption' }];
    expect(findRoutesMissingChokepoint(routeSources, exempt)).toEqual([]);
  });

  it('reports multiple missing routes, sorted lexicographically', () => {
    const routeSources = new Map<string, string>([
      ['src/app/api/portal/b/route.ts', 'no chokepoint reference here'],
      ['src/app/api/portal/a/route.ts', 'also missing the reference'],
    ]);
    expect(findRoutesMissingChokepoint(routeSources, [])).toEqual([
      'src/app/api/portal/a/route.ts',
      'src/app/api/portal/b/route.ts',
    ]);
  });

  it('a route exempted from an UNRELATED path is still flagged', () => {
    const routeSources = new Map<string, string>([
      ['src/app/api/portal/gap/route.ts', 'no chokepoint reference here'],
    ]);
    const exempt = [{ path: 'src/app/api/portal/other/route.ts', reason: 'not the same file' }];
    expect(findRoutesMissingChokepoint(routeSources, exempt)).toEqual([
      'src/app/api/portal/gap/route.ts',
    ]);
  });

  it('Task 7b — passes a fixture route that calls checkPortalAccess DIRECTLY (no requireMemberContext)', () => {
    const routeSources = new Map<string, string>([
      [
        'src/app/api/portal/fixture-direct-gate/route.ts',
        `import { checkPortalAccess } from '@/lib/lapsed-portal-scope';\n` +
          `import { buildPortalAccessDeps } from '@/lib/portal-access-deps';\n` +
          `export async function GET(request) {\n` +
          `  const decision = await checkPortalAccess(buildPortalAccessDeps(tenant), ctx);\n` +
          `  if (!decision.allowed) return new Response(null, { status: 403 });\n` +
          `}`,
      ],
    ]);
    expect(findRoutesMissingChokepoint(routeSources, [])).toEqual([]);
  });

  it('DIRECT_ACCESS_CHECK_SYMBOL matches the real production identifier', () => {
    expect(DIRECT_ACCESS_CHECK_SYMBOL).toBe('checkPortalAccess');
  });

  it('every EXEMPT_ROUTES entry carries a substantive documented reason', () => {
    expect(EXEMPT_ROUTES.length).toBeGreaterThan(0);
    for (const route of EXEMPT_ROUTES) {
      expect(route.path.length).toBeGreaterThan(0);
      expect(route.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('layoutHasPageChokepoint', () => {
  it('returns false when the layout source does not reference enforcePortalPageAccess', () => {
    expect(
      layoutHasPageChokepoint(`export default function Layout() { return null; }`),
    ).toBe(false);
  });

  it('returns true when the layout source imports + calls enforcePortalPageAccess', () => {
    const src =
      `import { enforcePortalPageAccess } from '@/lib/portal-page-access';\n` +
      `export default async function Layout() {\n` +
      `  const session = await requireSession('member');\n` +
      `  await enforcePortalPageAccess(session);\n` +
      `}`;
    expect(layoutHasPageChokepoint(src)).toBe(true);
  });
});

describe('production wiring (regression guard for the real files)', () => {
  it('symbol constants match the real production identifiers', () => {
    expect(CHOKEPOINT_SYMBOL).toBe('requireMemberContext');
    expect(PAGE_CHOKEPOINT_SYMBOL).toBe('enforcePortalPageAccess');
  });

  it('every REAL src/app/api/portal/**/route.ts file passes the gate (chokepoint or documented exemption)', () => {
    const apiPortalRoot = resolve(process.cwd(), 'src/app/api/portal');
    const entries = readdirSync(apiPortalRoot, { recursive: true, withFileTypes: true });
    const routeSources = new Map<string, string>();
    for (const e of entries) {
      if (!e.isFile() || e.name !== 'route.ts') continue;
      const parentPath =
        (e as { parentPath?: string; path?: string }).parentPath ??
        (e as { path: string }).path;
      const abs = resolve(join(parentPath, e.name));
      const rel = relative(process.cwd(), abs).split('\\').join('/');
      routeSources.set(rel, readFileSync(abs, 'utf8'));
    }
    expect(routeSources.size).toBeGreaterThan(0);
    expect(findRoutesMissingChokepoint(routeSources)).toEqual([]);
  });

  it('the REAL member portal layout references enforcePortalPageAccess', () => {
    const layoutPath = resolve(process.cwd(), 'src/app/(member)/portal/layout.tsx');
    const src = readFileSync(layoutPath, 'utf8');
    expect(layoutHasPageChokepoint(src)).toBe(true);
  });
});
