/**
 * T190 — Password-compare guard integration test (spec SC-018).
 *
 * Belt to the ESLint `no-restricted-syntax` braces in
 * `eslint.config.mjs` (which already blocks `password === x` at
 * lint-time). This test walks every file in `src/modules/auth/**` at
 * runtime and asserts no `===`/`==` comparison involves an identifier
 * starting with "password" — a second safety net against the day
 * someone disables the ESLint rule with an inline
 * `// eslint-disable-next-line`.
 *
 * Why a regex instead of an AST walker:
 *   - ESLint already owns the AST-accurate check.
 *   - Adding `@typescript-eslint/parser` as a direct test dep just to
 *     re-parse the same files would double the test deps without
 *     additional coverage.
 *   - The regex is purposely strict enough that the legitimate
 *     `argon2Hasher.verify()` / `hasher.verify()` call sites (which
 *     use method calls, not `===`) never match.
 *
 * False positive control:
 *   - We ignore comments (lines starting with `*`, `//`, or inside
 *     `/* *\/` blocks) so the doc-comments describing the rule don't
 *     themselves trip it.
 *   - We ignore this test file and the ESLint config itself so the
 *     rule-definition strings don't self-trigger.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..', '..');
const authRoot = join(repoRoot, 'src', 'modules', 'auth');

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strip `//` line comments, `/* *\/` block comments, and string
 * literals so that the password-compare regex doesn't match on doc
 * comments or string contents (e.g., error-message text that mentions
 * "password ==="). Simplified tokenizer — not bulletproof for edge
 * cases like nested template literals, but covers the F1 codebase.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len - 1 && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // Double-quoted string
    if (ch === '"') {
      i += 1;
      while (i < len && source[i] !== '"') {
        if (source[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    // Single-quoted string
    if (ch === "'") {
      i += 1;
      while (i < len && source[i] !== "'") {
        if (source[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      out += "''";
      continue;
    }
    // Template literal — simplify by dropping contents (${} may contain code, but
    // for this file set no templates contain `password ===` code)
    if (ch === '`') {
      i += 1;
      while (i < len && source[i] !== '`') {
        if (source[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      out += '``';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Identifier beginning with "password" (case-insensitive) on either side
// of a === or !== operator. Allows dotted property access (user.password).
const PASSWORD_COMPARE_RE =
  /(?:\b|\.)password[A-Za-z0-9_]*\s*[!=]==|[!=]==\s*(?:\b|\.)password[A-Za-z0-9_]*/i;

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function findViolations(source: string, relativePath: string): Violation[] {
  const stripped = stripCommentsAndStrings(source);
  const lines = stripped.split('\n');
  const originalLines = source.split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (PASSWORD_COMPARE_RE.test(lines[i]!)) {
      violations.push({
        file: relativePath,
        line: i + 1,
        snippet: (originalLines[i] ?? '').trim(),
      });
    }
  }
  return violations;
}

describe('integration: password-compare guard (T190, SC-018)', () => {
  it('no source file in src/modules/auth/** compares a password identifier with === or !==', async () => {
    const files = await walk(authRoot);
    expect(files.length).toBeGreaterThan(0);

    const allViolations: Violation[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const relative = file.replace(repoRoot, '').replace(/^[\\/]/, '');
      allViolations.push(...findViolations(source, relative));
    }

    if (allViolations.length > 0) {
      const report = allViolations.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join('\n');
      throw new Error(
        `Found ${allViolations.length} password-compare violation(s):\n${report}\n\n` +
          `Use argon2Hasher.verify() or the injected PasswordHasher port instead.`,
      );
    }
    expect(allViolations).toHaveLength(0);
  });
});
