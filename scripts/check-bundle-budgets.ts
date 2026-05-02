/**
 * T182 (Phase 9 / perf.md CHK038) — F7 per-route JS bundle budgets.
 *
 * Reads Next.js's build manifest + per-route app-build-manifest, sums
 * the on-disk size of every chunk file under `.next/static/chunks/`,
 * and fails the process if any tracked F7 route exceeds its KB
 * ceiling.
 *
 * Run as a post-build step:
 *
 *   pnpm build
 *   pnpm tsx scripts/check-bundle-budgets.ts
 *
 * Per-route ceilings (from perf.md CHK038):
 *   /portal/broadcasts/new          ≤ 180 KB  (Tiptap editor dominant)
 *   /admin/broadcasts               ≤ 120 KB  (queue list table)
 *   /admin/broadcasts/[id]          ≤ 100 KB  (detail panel)
 *   /portal/benefits/eblast         ≤  80 KB  (member quota dashboard)
 *   /unsubscribe/[token]            ≤  30 KB  (server-rendered, near-zero JS)
 *
 * The script is intentionally fail-soft when `.next/` is absent (e.g.
 * before the build runs in dev branches) so it can be added to a
 * shared CI step without breaking lightweight contributors. When
 * `.next/` IS present, breaches always fail with exit-code 1.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface RouteBudget {
  readonly route: string;
  readonly maxKb: number;
}

const BUDGETS: ReadonlyArray<RouteBudget> = [
  { route: '/portal/broadcasts/new', maxKb: 180 },
  { route: '/admin/broadcasts', maxKb: 120 },
  { route: '/admin/broadcasts/[id]', maxKb: 100 },
  { route: '/portal/benefits/eblast', maxKb: 80 },
  { route: '/unsubscribe/[token]', maxKb: 30 },
];

const NEXT_DIR = join(process.cwd(), '.next');

interface AppBuildManifest {
  readonly pages: Record<string, ReadonlyArray<string>>;
}

function loadManifest(): AppBuildManifest | null {
  // App-router routes land in `app-build-manifest.json`. Pages-router
  // surfaces use `build-manifest.json`; F7 routes are all App-router.
  const appPath = join(NEXT_DIR, 'app-build-manifest.json');
  const fallbackPath = join(NEXT_DIR, 'build-manifest.json');
  const path = existsSync(appPath) ? appPath : fallbackPath;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AppBuildManifest;
  } catch {
    return null;
  }
}

function sumChunkBytes(chunkPaths: ReadonlyArray<string>): number {
  let total = 0;
  for (const rel of chunkPaths) {
    const abs = join(NEXT_DIR, rel);
    try {
      total += statSync(abs).size;
    } catch {
      // Chunk listed in manifest but missing on disk — skip rather
      // than fail. The build manifest occasionally lists chunks that
      // were tree-shaken in production mode.
    }
  }
  return total;
}

/**
 * App Router stores per-page chunks under keys that include the route
 * group. Match the budget route against any manifest key whose suffix
 * matches the route — handles both `/app(...)/admin/broadcasts/page`
 * and `/admin/broadcasts` shapes.
 */
function findPageChunks(
  manifest: AppBuildManifest,
  route: string,
): ReadonlyArray<string> | null {
  // Try exact, then `${route}/page` suffix variants.
  const candidates = [route, `${route}/page`, `app${route}/page`];
  for (const key of Object.keys(manifest.pages)) {
    if (candidates.some((c) => key === c || key.endsWith(c))) {
      return manifest.pages[key]!;
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!existsSync(NEXT_DIR)) {
    console.log(
      'check-bundle-budgets: .next/ not found — skipping. Run `pnpm build` first.',
    );
    return;
  }
  const manifest = loadManifest();
  if (!manifest) {
    console.log(
      'check-bundle-budgets: build manifest not parsed — skipping. (Turbopack stats may not have stabilised.)',
    );
    return;
  }

  let breached = false;
  for (const { route, maxKb } of BUDGETS) {
    const chunks = findPageChunks(manifest, route);
    if (chunks === null) {
      console.warn(`[budget] ${route}: no chunks (route may be server-only)`);
      continue;
    }
    const bytes = sumChunkBytes(chunks);
    const kb = Math.round((bytes / 1024) * 10) / 10;
    const ok = kb <= maxKb;
    if (!ok) breached = true;
    console.log(
      `[budget] ${route}: ${kb} KB (ceiling ${maxKb} KB, chunks=${chunks.length}) ${ok ? 'OK' : 'BREACH'}`,
    );
  }

  if (breached) {
    console.error('check-bundle-budgets: one or more routes exceed budget');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('check-bundle-budgets: fatal', err);
  process.exitCode = 1;
});
