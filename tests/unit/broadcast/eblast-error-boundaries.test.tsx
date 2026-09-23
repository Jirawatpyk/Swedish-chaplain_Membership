/**
 * F119 T135 (US6-AS3, FR-047) — every E-Blast route shows the platform's
 * error state with a retry.
 *
 * Before T142 only two of the E-Blast routes had a segment boundary
 * (`/portal/broadcasts/new` and `/admin/settings/broadcasts/brand`). A throw
 * anywhere else bubbled to the ROOT boundary, which replaces the whole shell:
 * the member or the operator lost the sidebar, the nav and the page they were
 * on, and got no route-scoped retry.
 *
 * Senior-tester review H1 — this file used to carry a HAND-WRITTEN list of six
 * routes, so it could only ever pin the boundaries someone remembered to add.
 * `/admin/broadcasts/templates/new` and `/admin/broadcasts/templates/[id]/edit`
 * had a `page.tsx` and no `error.tsx`, inherited the template LIST's boundary
 * (`TableContainer` + the title "E-Blast templates" on a FORM failure — the
 * U10 class, exactly what T142 fixed one level up) and this test said nothing.
 *
 * So the route set is DERIVED from the filesystem: every directory under the
 * three E-Blast roots that owns a `page.tsx` must own an `error.tsx`, or be
 * named in `INHERITS_PARENT_BOUNDARY` with the parent it falls back to and the
 * reason that is right. A new route is covered the moment it exists.
 *
 * `discovered.length >= 9` is the positive control: a scan that cannot tell
 * "nothing to find" from "not looking" is not a check (CLAUDE.md § Gotchas).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ComponentType } from 'react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

type ErrorBoundary = ComponentType<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

/** The three route trees the E-Blast feature lives in. */
const ROOTS = [
  'src/app/(member)/portal/broadcasts',
  'src/app/(staff)/admin/broadcasts',
  'src/app/(staff)/admin/settings/broadcasts',
] as const;

/**
 * Routes deliberately served by an ancestor's boundary. Each entry states the
 * parent it falls through to — writing it down is the point, so "it inherits"
 * is a decision someone made rather than a file someone forgot.
 *
 * Empty today: every E-Blast route owns its own boundary.
 */
const INHERITS_PARENT_BOUNDARY: Readonly<Record<string, string>> = {};

/** Every directory under the roots that renders a page. */
function discoverRouteDirs(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const entries = readdirSync(resolve(process.cwd(), root), {
      recursive: true,
    }) as string[];
    for (const entry of entries) {
      const rel = entry.replace(/\\/g, '/');
      if (!rel.endsWith('page.tsx')) continue;
      const dir = dirname(rel);
      out.push(dir === '.' ? root : `${root}/${dir}`);
    }
  }
  return out.sort();
}

const DISCOVERED = discoverRouteDirs();

/**
 * Lazy module loaders keyed by root-relative path. `import.meta.glob` is
 * statically analysable (a bare `import(variable)` is not), and nothing is
 * evaluated until a boundary is actually rendered.
 */
// @ts-expect-error — `import.meta.glob` is a Vite transform. `vite/client` is
// not resolvable from the repo root under pnpm, so the TS lib does not know
// the member; the CALL must stay literal or Vite will not transform it.
const BOUNDARY_MODULES = import.meta.glob('/src/app/**/error.tsx') as Record<
  string,
  () => Promise<{ default: ErrorBoundary }>
>;

const owning = DISCOVERED.filter((dir) => INHERITS_PARENT_BOUNDARY[dir] === undefined);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('F119 T135 — E-Blast route error boundaries (US6-AS3, FR-047)', () => {
  it('the scan actually walked the route trees (a parse that finds nothing must not read as a pass)', () => {
    expect(DISCOVERED.length).toBeGreaterThanOrEqual(9);
    // …and every root contributed, so a renamed root cannot silently empty it.
    for (const root of ROOTS) {
      expect(DISCOVERED.some((d) => d.startsWith(root))).toBe(true);
    }
  });

  it('every route with a page.tsx owns an error.tsx, or declares the parent it inherits from', () => {
    const missing = DISCOVERED.filter(
      (dir) =>
        INHERITS_PARENT_BOUNDARY[dir] === undefined &&
        !existsSync(resolve(process.cwd(), dir, 'error.tsx')),
    );
    expect(
      missing,
      'a throw here replaces the whole shell instead of the segment, and offers no route-scoped retry (FR-047)',
    ).toEqual([]);
  });

  it.each(owning)('%s renders the shared error state with a working retry', async (dir) => {
    const load = BOUNDARY_MODULES[`/${dir}/error.tsx`];
    expect(load, `no module resolved for /${dir}/error.tsx`).toBeDefined();
    const { default: Boundary } = await load!();
    const reset = vi.fn();

    render(
      <Boundary
        error={Object.assign(new Error('boom'), { digest: 'abc123' })}
        reset={reset}
      />,
    );

    // The platform's error copy, not a route-local string.
    expect(screen.getAllByText('generic').length).toBeGreaterThan(0);
    // …and the error id, so a member can quote it to support.
    expect(screen.getByText('errorId')).toBeInTheDocument();

    // `fireEvent`, not `userEvent`: the shared `tests/setup.ts` installs
    // fake timers and userEvent's internal delay never advances under them.
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
