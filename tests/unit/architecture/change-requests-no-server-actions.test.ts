/**
 * F114 T117 — architecture guard (FR-038): every member and staff action of
 * the change-request feature is an HTTP route handler under the platform's
 * request guards (CSRF Origin allow-list in the proxy, in-route READ_ONLY_MODE,
 * RBAC denial audit) — NEVER a Server Action. A `'use server'` directive
 * anywhere in the feature's route, page or component trees would bypass all
 * three at once (research R5), so this scan fails on any hit.
 *
 * Two positive controls, so the guard cannot pass vacuously:
 *   1. the walk must yield at least MIN_FILES_SCANNED files (a renamed
 *      directory makes an empty scan LOUD rather than green);
 *   2. the SAME matcher must detect the directive in a fixture string (in
 *      both quote styles, and after a CRLF line ending — a `\n`-anchored
 *      regex is inert on every Windows checkout, CLAUDE.md § Gotchas).
 *
 * Directories that do not exist yet (the UI slice lands them) are skipped;
 * the file floor is what keeps that skip honest.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** Every tree FR-038 covers (tasks.md T117). */
const SCANNED_TREES = [
  'src/app/api/portal/change-requests',
  'src/app/api/admin/change-requests',
  'src/app/api/admin/settings/member-changes',
  'src/app/(member)/portal/change-requests',
  'src/app/(staff)/admin/change-requests',
  'src/components/members/change-requests',
] as const;

/** The server half alone is 10 route files; a scan below this has lost a tree. */
const MIN_FILES_SCANNED = 10;

const SOURCE_EXT = /\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/**
 * A `'use server'` / `"use server"` directive: at the start of the file or at
 * the start of a line (a file-level or function-level directive), followed by
 * an optional `;`. `\r?\n` — never `\n` alone — so the CRLF working tree on
 * the maintainer's machine is scanned the same way CI's LF checkout is.
 */
const USE_SERVER_DIRECTIVE = /(^|\r?\n)[ \t]*(['"])use server\2[ \t]*;?[ \t]*(\r?\n|$)/;

function containsUseServer(source: string): boolean {
  return USE_SERVER_DIRECTIVE.test(source);
}

const scanned = SCANNED_TREES.flatMap((tree) => {
  const abs = resolve(ROOT, tree);
  return existsSync(abs) ? walk(abs) : [];
}).map((abs) => ({ abs, rel: abs.slice(ROOT.length + 1).split('\\').join('/') }));

describe('F114 change-request surfaces carry no Server Action (FR-038)', () => {
  it(`positive control: the scan covers at least ${MIN_FILES_SCANNED} source files`, () => {
    expect(scanned.length, scanned.map((f) => f.rel).join('\n')).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
  });

  it('positive control: the matcher detects the directive in both quote styles, with a semicolon, and after CRLF', () => {
    expect(containsUseServer("'use server'\nexport async function act() {}")).toBe(true);
    expect(containsUseServer('"use server";\r\nexport async function act() {}')).toBe(true);
    expect(containsUseServer("export async function act() {\r\n  'use server';\r\n}")).toBe(true);
    expect(containsUseServer("export async function act() {\n  'use server'\n}")).toBe(true);
    // prose that merely mentions the directive is not a directive
    expect(containsUseServer("// never 'use server' here\nexport const GET = () => null;")).toBe(false);
    expect(containsUseServer("'use client';\nexport default function C() { return null; }")).toBe(false);
  });

  it.each(scanned.map((f) => [f.rel, f.abs] as const))('%s has no use-server directive', (_rel, abs) => {
    const source = readFileSync(abs, 'utf8');
    expect(containsUseServer(source), `'use server' found in ${_rel} — F114 actions must be route handlers under the platform guards (FR-038)`).toBe(false);
  });
});
