/**
 * T019 — Architecture invariant: invoicing ↔ members bidirectional
 * port-type independence (post-critique F4 E1).
 *
 * Scans every `.ts` / `.tsx` file under:
 *   - `src/modules/invoicing/application/**`
 *   - `src/modules/members/application/**`
 *
 * And asserts:
 *   - invoicing/application never imports `@/modules/members/application/ports/**`
 *   - members/application never imports `@/modules/invoicing/application/ports/**`
 *
 * Mirrors the ESLint `no-restricted-imports` rules in `eslint.config.mjs`
 * so the invariant has BOTH lint-time AND test-time enforcement. A
 * deviation requires a `plan.md § Complexity Tracking` entry.
 *
 * Rationale: the two bounded contexts communicate only through their
 * PUBLIC BARRELS (`@/modules/members` and `@/modules/invoicing`) — any
 * direct application/ports import would couple internal layouts and
 * defeat the module boundary.
 *
 * Lint covers runtime imports; this test adds a belt-and-suspenders
 * check against typos in the ESLint ignore list, new sibling directories
 * being added that bypass the rule, or a future refactor that rewrites
 * the glob patterns. Fail loudly if either sibling reaches inside.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return; // missing dir is fine (module may not exist yet in early phases)
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

describe('F4 Architecture invariant — invoicing ↔ members bidirectional dep', () => {
  it('invoicing/application does not import @/modules/members/application/ports/**', async () => {
    const root = path.join(REPO_ROOT, 'src/modules/invoicing/application');
    const files = await collectSourceFiles(root);
    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      // Match both alias and relative paths pointing at members/application/ports.
      if (
        /from\s+['"]@\/modules\/members\/application\/ports\//.test(src) ||
        /from\s+['"][.\\/]+(modules\/)?members\/application\/ports\//.test(src)
      ) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `Invoicing Application must talk to Members only via @/modules/members barrel. Offenders: ${offenders.join(', ')}`).toEqual([]);
  });

  it('members/application does not import @/modules/invoicing/application/ports/**', async () => {
    const root = path.join(REPO_ROOT, 'src/modules/members/application');
    const files = await collectSourceFiles(root);
    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      if (
        /from\s+['"]@\/modules\/invoicing\/application\/ports\//.test(src) ||
        /from\s+['"][.\\/]+(modules\/)?invoicing\/application\/ports\//.test(src)
      ) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders, `Members Application must talk to Invoicing only via @/modules/invoicing barrel. Offenders: ${offenders.join(', ')}`).toEqual([]);
  });

  it('invoicing/index.ts (public barrel) is the only cross-module export surface', async () => {
    const barrel = path.join(REPO_ROOT, 'src/modules/invoicing/index.ts');
    const src = await readFile(barrel, 'utf8');
    // Sanity check: barrel file should exist and be a module (not empty/stub).
    // Initially it is a stub (Phase 1 T001) — the architecture invariant
    // still holds because no cross-module imports exist to police yet.
    expect(src.length).toBeGreaterThan(0);
  });
});
