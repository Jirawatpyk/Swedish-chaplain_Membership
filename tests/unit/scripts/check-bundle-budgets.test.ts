/**
 * 058 repair — unit tests for `scripts/check-bundle-budgets.ts`.
 *
 * The gate had been silently passing for months: it read a manifest file
 * (`.next/app-build-manifest.json`) that Next 16 + Turbopack no longer
 * emits, found zero chunks for every route, and `continue`d past all of
 * them instead of failing. These tests pin the replacement contract —
 * built on `.next/diagnostics/route-bundle-stats.json` — so that
 * regression class can never go silent again:
 *   - a route under budget passes
 *   - a route over budget fails
 *   - a budgeted route missing from the stats fails (not skipped)
 *   - a missing/unreadable stats source fails (not skipped)
 *   - `.next/` entirely absent (nobody built) is the one legitimate skip
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesToKb,
  evaluateBudgets,
  hasFailure,
  loadStats,
  parseStatsJson,
  type RouteBudget,
  type RouteBundleStat,
} from '@/../scripts/check-bundle-budgets';

// ---------------------------------------------------------------------------
// bytesToKb
// ---------------------------------------------------------------------------
describe('bytesToKb', () => {
  it('converts bytes to KB rounded to 1 decimal place', () => {
    expect(bytesToKb(1252595)).toBeCloseTo(1223.2, 1);
  });

  it('handles zero bytes', () => {
    expect(bytesToKb(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseStatsJson
// ---------------------------------------------------------------------------
describe('parseStatsJson', () => {
  it('parses a well-formed route-bundle-stats.json array', () => {
    const raw = JSON.stringify([
      { route: '/admin/members/new', firstLoadUncompressedJsBytes: 1252595 },
    ]);
    expect(parseStatsJson(raw)).toEqual([
      { route: '/admin/members/new', firstLoadUncompressedJsBytes: 1252595 },
    ]);
  });

  it('throws when the top-level JSON is not an array', () => {
    expect(() => parseStatsJson(JSON.stringify({ route: '/x' }))).toThrow();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseStatsJson('{not json')).toThrow();
  });

  it('throws when an entry is missing `route`', () => {
    const raw = JSON.stringify([{ firstLoadUncompressedJsBytes: 100 }]);
    expect(() => parseStatsJson(raw)).toThrow();
  });

  it('throws when an entry is missing `firstLoadUncompressedJsBytes`', () => {
    const raw = JSON.stringify([{ route: '/x' }]);
    expect(() => parseStatsJson(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// evaluateBudgets
// ---------------------------------------------------------------------------
describe('evaluateBudgets', () => {
  const stats: ReadonlyArray<RouteBundleStat> = [
    { route: '/admin/members/new', firstLoadUncompressedJsBytes: 1223 * 1024 },
    { route: '/admin/broadcasts', firstLoadUncompressedJsBytes: 2200 * 1024 },
  ];

  it('passes a route measured under its ceiling', () => {
    const budgets: ReadonlyArray<RouteBudget> = [
      { route: '/admin/members/new', maxKb: 1330 },
    ];
    const [result] = evaluateBudgets(budgets, stats);
    expect(result!.status).toBe('ok');
    expect(result!.actualKb).toBeCloseTo(1223, 0);
  });

  it('fails a route measured over its ceiling', () => {
    const budgets: ReadonlyArray<RouteBudget> = [
      { route: '/admin/broadcasts', maxKb: 2140 },
    ];
    const [result] = evaluateBudgets(budgets, stats);
    expect(result!.status).toBe('breach');
    expect(result!.actualKb).toBeCloseTo(2200, 0);
  });

  it('fails (does not skip) a budgeted route absent from the stats array', () => {
    const budgets: ReadonlyArray<RouteBudget> = [
      { route: '/portal/benefits/eblast', maxKb: 1050 }, // the historical typo
    ];
    const [result] = evaluateBudgets(budgets, stats);
    expect(result!.status).toBe('missing');
    expect(result!.actualKb).toBeNull();
  });

  it('treats an expectServerOnly route absent from stats as OK', () => {
    const budgets: ReadonlyArray<RouteBudget> = [
      { route: '/some/server-only/route', maxKb: 0, expectServerOnly: true },
    ];
    const [result] = evaluateBudgets(budgets, stats);
    expect(result!.status).toBe('ok');
    expect(result!.actualKb).toBeNull();
  });

  it('fails an expectServerOnly route that unexpectedly has client JS', () => {
    const budgets: ReadonlyArray<RouteBudget> = [
      { route: '/admin/members/new', maxKb: 0, expectServerOnly: true },
    ];
    const [result] = evaluateBudgets(budgets, stats);
    expect(result!.status).toBe('unexpected-client-js');
    expect(result!.actualKb).toBeCloseTo(1223, 0);
  });
});

// ---------------------------------------------------------------------------
// hasFailure
// ---------------------------------------------------------------------------
describe('hasFailure', () => {
  it('returns false when every result is ok', () => {
    expect(
      hasFailure([
        { route: '/a', maxKb: 100, actualKb: 50, status: 'ok' },
        { route: '/b', maxKb: 100, actualKb: null, status: 'ok' },
      ]),
    ).toBe(false);
  });

  it.each(['breach', 'missing', 'unexpected-client-js'] as const)(
    'returns true when any result has status %s',
    (status) => {
      expect(
        hasFailure([
          { route: '/a', maxKb: 100, actualKb: 50, status: 'ok' },
          { route: '/b', maxKb: 100, actualKb: 999, status },
        ]),
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// loadStats — real (fixtured) filesystem, isolated from the repo's own
// .next/ so the test suite never depends on whether a build happens to
// exist on disk.
// ---------------------------------------------------------------------------
describe('loadStats', () => {
  let fixtureRoot: string;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function makeFixtureRoot(): string {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'check-bundle-budgets-'));
    return fixtureRoot;
  }

  it('returns no-build when the .next directory does not exist at all', () => {
    const root = makeFixtureRoot();
    const nextDir = join(root, '.next');
    const statsPath = join(nextDir, 'diagnostics', 'route-bundle-stats.json');
    expect(loadStats(nextDir, statsPath)).toEqual({ kind: 'no-build' });
  });

  it('returns unreadable when .next/ exists but the stats file is absent (nobody skips this)', () => {
    const root = makeFixtureRoot();
    const nextDir = join(root, '.next');
    mkdirSync(nextDir, { recursive: true });
    const statsPath = join(nextDir, 'diagnostics', 'route-bundle-stats.json');
    const result = loadStats(nextDir, statsPath);
    expect(result.kind).toBe('unreadable');
  });

  it('returns unreadable when the stats file exists but contains malformed JSON', () => {
    const root = makeFixtureRoot();
    const nextDir = join(root, '.next');
    const diagDir = join(nextDir, 'diagnostics');
    mkdirSync(diagDir, { recursive: true });
    const statsPath = join(diagDir, 'route-bundle-stats.json');
    writeFileSync(statsPath, '{not valid json', 'utf-8');
    const result = loadStats(nextDir, statsPath);
    expect(result.kind).toBe('unreadable');
  });

  it('returns ok with parsed stats when the file is well-formed', () => {
    const root = makeFixtureRoot();
    const nextDir = join(root, '.next');
    const diagDir = join(nextDir, 'diagnostics');
    mkdirSync(diagDir, { recursive: true });
    const statsPath = join(diagDir, 'route-bundle-stats.json');
    writeFileSync(
      statsPath,
      JSON.stringify([
        { route: '/admin/members/new', firstLoadUncompressedJsBytes: 1252595 },
      ]),
      'utf-8',
    );
    const result = loadStats(nextDir, statsPath);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.stats).toEqual([
        { route: '/admin/members/new', firstLoadUncompressedJsBytes: 1252595 },
      ]);
    }
  });
});
