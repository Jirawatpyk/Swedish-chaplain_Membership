/**
 * T182 (Phase 9 / perf.md CHK038) — F7 / F8 / members per-route JS bundle
 * budgets.
 *
 * 058 repair (2026-07): the previous version read
 * `.next/app-build-manifest.json`, a webpack-era App Router manifest that
 * Next 16 + Turbopack no longer emits. The fallback it fell through to
 * (`.next/build-manifest.json`) is the pages-router shape and has no App
 * Router entries, so every route matched zero chunks and the loop below
 * used to `continue` past all of them — the gate passed green by checking
 * nothing, for any route, for months. That silent-skip is gone: a missing
 * measurement now FAILS the run instead of being skipped (see `loadStats`
 * / `evaluateBudgets`).
 *
 * Source of truth is now `.next/diagnostics/route-bundle-stats.json`, a
 * Turbopack build diagnostics file: a JSON array of
 * `{ route, firstLoadUncompressedJsBytes, firstLoadChunkPaths }`, one
 * entry per App Router route, keyed on the clean route path (no route
 * group prefix — no more suffix-matching gymnastics).
 *
 * The metric changed meaning along with the source. The old script summed
 * only the page's own chunk files (webpack `manifest.pages[route]`), which
 * is why old ceilings sat in the 30-180 KB range. `firstLoadUncompressedJsBytes`
 * is the full first-load JS for the route INCLUDING shared framework /
 * vendor chunks, so real numbers are in the 600 KB-2 MB range. Do not
 * compare post-repair KB numbers against pre-repair ceilings — they are
 * different quantities. Every ceiling below was re-baselined from a real
 * `pnpm build` measurement against this new source (058 repair).
 *
 * No webpack/app-build-manifest fallback is kept. Turbopack is this
 * project's only build path (`pnpm build`, `pnpm dev` both pass
 * `--turbopack`; see package.json), so a webpack-shaped fallback would be
 * dead code exercised by nothing — and even if Next ever regressed back to
 * webpack for a build, the two metrics aren't comparable, so silently
 * falling back would just reintroduce a different flavour of "measures the
 * wrong thing without telling anyone."
 *
 * Re-baselining rule for the ceilings below (apply the same rule next time
 * routes are re-measured, so ceilings stay comparable to each other):
 *   maxKb = ceil(measuredKb / 10) * 10 + 100
 * i.e. round the measured first-load KB up to the nearest 10, then add a
 * flat 100 KB of headroom. The flat 100 KB absorbs normal build-to-build
 * variance (chunk-hash/vendor-split churn) without being so loose that the
 * budget stops catching real regressions. For the members routes in
 * particular, this headroom (~103-107 KB) is deliberately well under the
 * 367 KB (uncompressed) Thai postal reference dataset — the exact
 * regression these two budgets exist to catch if that dataset ever leaks
 * into a client bundle instead of staying behind
 * `import 'server-only'` + `/api/geo/postal/[code]`. A headroom close to
 * or above 367 KB would defeat the budget's purpose.
 *
 * Ceilings measured 2026-07-14 against a real `pnpm build`
 * (Next 16.2.3, Turbopack):
 *
 *   F7 broadcasts:
 *     /portal/broadcasts/new          1991 KB measured → ≤ 2100 KB
 *     /admin/broadcasts               2037 KB measured → ≤ 2140 KB
 *     /admin/broadcasts/[id]          1928 KB measured → ≤ 2030 KB
 *     /portal/benefits/e-blasts        943 KB measured → ≤ 1050 KB
 *       (route string fixed 058 repair — was the stale, never-matching
 *       `/portal/benefits/eblast`, itself a second live instance of the
 *       exact "typo passes silently" failure this repair closes)
 *     /unsubscribe/[token]             584 KB measured → ≤  690 KB
 *   F8 renewals (Phase 9 / T255):
 *     /admin/renewals                 1151 KB measured → ≤ 1260 KB
 *     /admin/renewals/[cycleId]       1036 KB measured → ≤ 1140 KB
 *     /admin/renewals/tasks           1087 KB measured → ≤ 1190 KB
 *     /admin/renewals/tier-upgrades    996 KB measured → ≤ 1100 KB
 *     /portal/renewal/[memberId]       985 KB measured → ≤ 1090 KB
 *     /portal/preferences/renewals     938 KB measured → ≤ 1040 KB
 *     /admin/settings/renewals/schedules
 *                                     1057 KB measured → ≤ 1160 KB
 *   Members (058 / PR-B — guards the 367 KB (uncompressed) Thai postal
 *   reference dataset, which must stay server-only):
 *     /admin/members/new              1223 KB measured → ≤ 1330 KB
 *     /admin/members/[memberId]/edit  1247 KB measured → ≤ 1350 KB
 *
 *   067 dashboard-interactive-charts:
 *     /admin  Task 7 (pre-chart) baseline: 992 KB measured → ≤ 1100 KB
 *       (measured 2026-07-16, BEFORE any route imports recharts —
 *       `recharts@^3` + `ui/chart.tsx` installed but not yet wired into
 *       any admin page.)
 *     /admin  Task 14 (post-chart) re-baseline: 1004.8 KB measured → ≤ 1110 KB
 *       (measured 2026-07-17, `pnpm build` AFTER all four charts —
 *       revenue-trend + member-growth sparklines, membership-tier bar,
 *       invoice-status donut — are wired into `(staff)/admin/(home)/page.tsx`.
 *       `firstLoadUncompressedJsBytes` = 1,028,918 bytes, a mere +12.9 KB
 *       (+1.3%) over the pre-chart baseline — proof recharts (~100-400 KB
 *       uncompressed for the library alone) did NOT leak into first-load:
 *       every chart's actual `<BarChart>`/`<AreaChart>`/`<PieChart>` canvas
 *       is behind its own `next/dynamic(..., { ssr: false })` boundary
 *       (`*-canvas.tsx` files), confirmed by grepping every EAGER
 *       `*-chart.tsx` file for a direct `recharts` import (zero hits — only
 *       the lazy `*-canvas.tsx` siblings import it). Re-baselined ceiling
 *       per this file's own rule: `ceil(1004.8/10)*10 + 100 = 1110`. This
 *       supersedes the Task 7 pre-chart ceiling — do not revert to 1100.)
 *

 * Run as a post-build step:
 *
 *   pnpm build
 *   pnpm check:bundle-budgets
 *
 * `.next/` entirely absent (nobody has run `pnpm build` yet, e.g. a
 * lightweight contributor on a fresh checkout) is the one legitimate skip.
 * Once `.next/` exists, every other failure mode — an unreadable/missing
 * stats file, or a budgeted route absent from it — is a hard failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RouteBundleStat {
  readonly route: string;
  readonly firstLoadUncompressedJsBytes: number;
}

export interface RouteBudget {
  readonly route: string;
  readonly maxKb: number;
  /**
   * Set only for a route that is genuinely server-only (zero client JS)
   * and therefore correctly absent from route-bundle-stats.json. Asserts
   * the ABSENCE of client chunks rather than silently skipping the route:
   * if it later gains a client bundle, the check flips to a hard failure
   * (`unexpected-client-js`) instead of going unnoticed — the same class
   * of bug this whole repair exists to close. No budgeted route needs
   * this flag today; every route below has real client JS and a real
   * `route-bundle-stats.json` entry. Kept for the next genuinely
   * server-only route someone adds to this file.
   */
  readonly expectServerOnly?: true;
}

const BUDGETS: ReadonlyArray<RouteBudget> = [
  // --- F7 broadcasts ---------------------------------------------------
  { route: '/portal/broadcasts/new', maxKb: 2100 },
  { route: '/admin/broadcasts', maxKb: 2140 },
  { route: '/admin/broadcasts/[id]', maxKb: 2030 },
  { route: '/portal/benefits/e-blasts', maxKb: 1050 },
  { route: '/unsubscribe/[token]', maxKb: 690 },
  // --- F8 renewals (Phase 9 / T255) ------------------------------------
  { route: '/admin/renewals', maxKb: 1260 },
  { route: '/admin/renewals/[cycleId]', maxKb: 1140 },
  { route: '/admin/renewals/tasks', maxKb: 1190 },
  { route: '/admin/renewals/tier-upgrades', maxKb: 1100 },
  { route: '/portal/renewal/[memberId]', maxKb: 1090 },
  { route: '/portal/preferences/renewals', maxKb: 1040 },
  // PR #24 review-fix — schedule editor is the only F8 admin surface
  // with a non-trivial client component (`ScheduleEditor`); without a
  // budget here a future refactor could silently regress JS payload.
  // The `/portal/renewal/[memberId]/success` page is fully server-
  // rendered and has no client JS, so no budget entry is needed.
  { route: '/admin/settings/renewals/schedules', maxKb: 1160 },
  // --- Members (058 / PR-B) --------------------------------------------
  // The Thai postal dataset (367 KB uncompressed) is server-only, behind
  // /api/geo/postal/[code] and an `import 'server-only'` guard. If it ever
  // lands in the client bundle, these budgets are what catches it — see
  // the headroom-rule note in the docblock above for why their headroom
  // is deliberately kept well under 367 KB.
  { route: '/admin/members/new', maxKb: 1330 },
  { route: '/admin/members/[memberId]/edit', maxKb: 1350 },
  // --- 067 dashboard-interactive-charts (Task 14 post-chart re-baseline) -
  // 1004.8 KB measured with all four charts wired — see docblock above.
  { route: '/admin', maxKb: 1110 },
];

const NEXT_DIR = join(process.cwd(), '.next');
const STATS_PATH = join(NEXT_DIR, 'diagnostics', 'route-bundle-stats.json');

export function bytesToKb(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}

/**
 * Parses `route-bundle-stats.json`'s contents, validating the minimal
 * shape this script depends on. Throws (rather than returning null) on
 * anything unexpected — the caller (`loadStats`) converts that into an
 * `unreadable` result, which `main` treats as a hard failure, not a skip.
 */
export function parseStatsJson(raw: string): ReadonlyArray<RouteBundleStat> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('route-bundle-stats.json: expected a top-level array');
  }
  for (const entry of parsed as ReadonlyArray<unknown>) {
    const e = entry as Record<string, unknown>;
    if (typeof e?.route !== 'string') {
      throw new Error(
        'route-bundle-stats.json: entry missing string `route` field',
      );
    }
    if (typeof e?.firstLoadUncompressedJsBytes !== 'number') {
      throw new Error(
        `route-bundle-stats.json: entry "${e.route}" missing numeric ` +
          '`firstLoadUncompressedJsBytes` field',
      );
    }
  }
  return parsed as ReadonlyArray<RouteBundleStat>;
}

export type StatsLoadResult =
  | { readonly kind: 'no-build' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly stats: ReadonlyArray<RouteBundleStat> };

/**
 * Round 058-repair — parameterised on `nextDir`/`statsPath` (rather than
 * reading the module-level constants directly) so unit tests can point it
 * at a throwaway fixture directory instead of depending on whatever
 * `.next/` state happens to exist on the machine running the tests.
 */
export function loadStats(nextDir: string, statsPath: string): StatsLoadResult {
  if (!existsSync(nextDir)) {
    // The one legitimate skip: nobody has run `pnpm build` yet.
    return { kind: 'no-build' };
  }
  if (!existsSync(statsPath)) {
    return {
      kind: 'unreadable',
      reason: `${statsPath} not found (expected Turbopack build diagnostics)`,
    };
  }
  try {
    const raw = readFileSync(statsPath, 'utf-8');
    return { kind: 'ok', stats: parseStatsJson(raw) };
  } catch (err) {
    return {
      kind: 'unreadable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export type BudgetStatus =
  | 'ok'
  | 'breach'
  | 'missing'
  | 'unexpected-client-js';

export interface BudgetResult {
  readonly route: string;
  readonly maxKb: number;
  readonly actualKb: number | null;
  readonly status: BudgetStatus;
}

/**
 * Pure comparison: budgeted routes × measured stats → per-route verdicts.
 * No file I/O — the `no chunks → continue` bug this repair fixes lived
 * entirely in this kind of logic, so it is the part most worth pinning
 * with unit tests independent of any real build.
 */
export function evaluateBudgets(
  budgets: ReadonlyArray<RouteBudget>,
  stats: ReadonlyArray<RouteBundleStat>,
): ReadonlyArray<BudgetResult> {
  const byRoute = new Map(stats.map((s) => [s.route, s] as const));
  return budgets.map((budget) => {
    const entry = byRoute.get(budget.route);
    if (budget.expectServerOnly) {
      if (entry) {
        return {
          route: budget.route,
          maxKb: budget.maxKb,
          actualKb: bytesToKb(entry.firstLoadUncompressedJsBytes),
          status: 'unexpected-client-js',
        };
      }
      return {
        route: budget.route,
        maxKb: budget.maxKb,
        actualKb: null,
        status: 'ok',
      };
    }
    if (!entry) {
      return {
        route: budget.route,
        maxKb: budget.maxKb,
        actualKb: null,
        status: 'missing',
      };
    }
    const actualKb = bytesToKb(entry.firstLoadUncompressedJsBytes);
    return {
      route: budget.route,
      maxKb: budget.maxKb,
      actualKb,
      status: actualKb <= budget.maxKb ? 'ok' : 'breach',
    };
  });
}

export function formatResultLine(result: BudgetResult): string {
  switch (result.status) {
    case 'ok':
      return result.actualKb === null
        ? `[budget] ${result.route}: OK (server-only, no client chunks, as expected)`
        : `[budget] ${result.route}: ${result.actualKb} KB (ceiling ${result.maxKb} KB) OK`;
    case 'breach':
      return `[budget] ${result.route}: ${result.actualKb} KB (ceiling ${result.maxKb} KB) BREACH`;
    case 'missing':
      return (
        `[budget] ${result.route}: FAIL — no entry in route-bundle-stats.json ` +
        '(route renamed, deleted, or mistyped?)'
      );
    case 'unexpected-client-js':
      return (
        `[budget] ${result.route}: FAIL — expected server-only ` +
        `(expectServerOnly: true) but found ${result.actualKb} KB of client JS`
      );
  }
}

export function hasFailure(results: ReadonlyArray<BudgetResult>): boolean {
  return results.some((r) => r.status !== 'ok');
}

function main(): void {
  const loaded = loadStats(NEXT_DIR, STATS_PATH);

  if (loaded.kind === 'no-build') {
    console.log(
      'check-bundle-budgets: .next/ not found — skipping. Run `pnpm build` first.',
    );
    return;
  }

  if (loaded.kind === 'unreadable') {
    console.error(
      `check-bundle-budgets: .next/ is present but the bundle stats source ` +
        `could not be read (${loaded.reason}). Failing rather than skipping — ` +
        'a silent skip here is exactly the bug this gate used to have.',
    );
    process.exitCode = 1;
    return;
  }

  const results = evaluateBudgets(BUDGETS, loaded.stats);
  for (const result of results) {
    if (result.status === 'ok') {
      console.log(formatResultLine(result));
    } else {
      console.error(formatResultLine(result));
    }
  }

  if (hasFailure(results)) {
    console.error(
      'check-bundle-budgets: one or more routes breached their budget or ' +
        'are missing from route-bundle-stats.json',
    );
    process.exitCode = 1;
    return;
  }
  console.log('check-bundle-budgets: all routes within budget.');
}

// Run when invoked as a CLI entry point (not when imported by tests).
// `process.argv[1]` ends with this filename for direct `tsx` calls; under
// vitest, the worker entry differs.
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('check-bundle-budgets')
) {
  try {
    main();
  } catch (err) {
    console.error('check-bundle-budgets: fatal', err);
    process.exitCode = 1;
  }
}
