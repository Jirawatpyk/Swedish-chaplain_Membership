/**
 * Architecture test — Application-layer import ban (Constitution Principle III,
 * NON-NEGOTIABLE) — go-live audit S1-P0-2 backstop.
 *
 * **Why a source-scan test (and not just ESLint):**
 * The ESLint `no-restricted-imports` rule for the application layer
 * (`eslint.config.mjs`) is silently SHADOWED at runtime by the global F6
 * events-brand block (`files: ["src/**\/*.{ts,tsx}"]`, last-wins in flat
 * config). The go-live audit found the drizzle/infrastructure-VALUE ban was
 * therefore non-functional, which let a raw Drizzle query land in
 * `members/application/use-cases/count-active-members-on-plan.ts` (S1-P0-3).
 * The barrel tests (broadcasts/events/insights) backstop the Presentation↔
 * module boundary the same way; this file backstops the layer-internal ban.
 *
 * It scans every `src/modules/*\/application/**` file and fails on a VALUE
 * import of: an ORM/framework (`drizzle-orm`, `next`, `react`, `postgres`), or
 * a project-local `**\/infrastructure/**` path. `import type { ... }` is allowed
 * (erases at compile time → no runtime coupling, legitimate DI port wiring).
 * Composition roots (`*-deps.ts`) are exempt — they are the documented place to
 * wire Infrastructure adapters.
 *
 * KNOWN_BACKLOG: pre-existing violations the ban never caught (because it was
 * shadowed). They are tracked as P1 go-live findings (S1-P1-13) and cleared in
 * the Stage 2 P1 batch; until then they are allow-listed so the test locks the
 * baseline and blocks NEW violations.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const MODULES_DIR = join(PROJECT_ROOT, 'src', 'modules');

// Forbidden bare module names (value imports only).
const FORBIDDEN_PACKAGES = [
  'drizzle-orm',
  'postgres',
  'next',
  'react',
  'react-dom',
];

// VALUE import of a project-local infrastructure path (relative or alias).
const INFRA_PATH = /(^|['"])(@\/modules\/[^/]+\/infrastructure\/|(\.\.?\/)+infrastructure\/)/;

// Pre-existing violations are now CLEARED (S1-P1-13 fixed in Stage 2 Medium-E:
// MalformedHashError + retryAfterSeconds moved into the Application layer). The
// backlog is empty — any NEW application→infrastructure VALUE import fails the
// first test below. Keep this list empty; do not add to it without an audit.
// Key format: "<module-relative path>::<imported source>".
const KNOWN_BACKLOG = new Set<string>([]);

function listAppFiles(): string[] {
  const out: string[] = [];
  const modules = readdirSync(MODULES_DIR);
  for (const mod of modules) {
    const appDir = join(MODULES_DIR, mod, 'application');
    let exists = false;
    try {
      exists = statSync(appDir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    walk(appDir, out);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
}

/** Returns each VALUE import's source string from a file (skips `import type`). */
function valueImportSources(content: string): string[] {
  const sources: string[] = [];
  // Match top-level import statements. Skip pure type-only imports.
  const re = /import\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const isTypeOnly = Boolean(m[1]); // `import type { ... }`
    if (isTypeOnly) continue;
    const src = m[3];
    if (src) sources.push(src);
  }
  return sources;
}

describe('Architecture — application layer must not import ORM/framework/infrastructure VALUES (Principle III)', () => {
  it('has no NEW forbidden value imports outside the audit-tracked backlog', () => {
    const violations: string[] = [];
    for (const file of listAppFiles()) {
      const rel = relative(MODULES_DIR, file).split(sep).join('/');
      // Composition roots legitimately wire Infrastructure adapters.
      if (/-deps\.ts$/.test(rel) || /\/deps\.ts$/.test(rel)) continue;

      const content = readFileSync(file, 'utf8');
      for (const src of valueImportSources(content)) {
        const forbiddenPkg = FORBIDDEN_PACKAGES.some(
          (p) => src === p || src.startsWith(`${p}/`),
        );
        const forbiddenInfra = INFRA_PATH.test(src);
        if (!forbiddenPkg && !forbiddenInfra) continue;

        const key = `${rel}::${src}`;
        if (KNOWN_BACKLOG.has(key)) continue;
        violations.push(key);
      }
    }
    expect(violations, `New Principle III application-layer violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('KNOWN_BACKLOG has no stale entries (each must still violate)', () => {
    const live = new Set<string>();
    for (const file of listAppFiles()) {
      const rel = relative(MODULES_DIR, file).split(sep).join('/');
      if (/-deps\.ts$/.test(rel) || /\/deps\.ts$/.test(rel)) continue;
      const content = readFileSync(file, 'utf8');
      for (const src of valueImportSources(content)) {
        const forbidden =
          FORBIDDEN_PACKAGES.some((p) => src === p || src.startsWith(`${p}/`)) ||
          INFRA_PATH.test(src);
        if (forbidden) live.add(`${rel}::${src}`);
      }
    }
    const stale = [...KNOWN_BACKLOG].filter((k) => !live.has(k));
    expect(stale, `Stale KNOWN_BACKLOG entries (fixed — remove them):\n${stale.join('\n')}`).toEqual([]);
  });
});
