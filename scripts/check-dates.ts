#!/usr/bin/env tsx
/**
 * Date-pattern regression guard — prevents re-introducing banned inline
 * date-formatting patterns after the 061-date-standardization migration.
 *
 * Context: Chamber-OS routes ALL general date display through two canonical
 * helpers:
 *   - `getDateFormatLocale` / `formatLocalisedDate`  (src/lib/format-date-localised.ts)
 *   - `formatTaxDocDate`                              (src/lib/format-tax-doc-date.ts)
 *
 * Banned patterns (2 signals, both unambiguous for date logic):
 *
 *   1. Inline `u-ca-buddhist` calendar literals  — any string containing
 *      `u-ca-buddhist` in display code.  The canonical helpers are the ONLY
 *      legitimate location for this literal; calling sites must use the
 *      helpers instead of re-implementing the locale mapping themselves.
 *
 *   2. Bare-locale Intl date APIs — `toLocaleDateString(locale` and
 *      `new Intl.DateTimeFormat(locale` — where `locale` is an unresolved
 *      variable.  Correct call sites wrap the locale with
 *      `getDateFormatLocale(locale)` so the Buddhist-Era calendar is applied
 *      for `th-TH` and the guard does NOT fire.
 *
 * Why NOT ban `toLocaleString(locale)`?
 *   `toLocaleString` is legitimately used for NUMBER / currency formatting
 *   (e.g. `amount.toLocaleString(locale)` for THB amounts in events tables,
 *   calendar month labels).  A broad ban would produce false positives.
 *   The two signals above are sufficient to catch all date-specific sites.
 *
 * Allow-listed files (the canonical helpers themselves):
 *   - src/lib/format-date-localised.ts
 *   - src/lib/format-tax-doc-date.ts
 *
 * The script intentionally FAILS until Task 10 of 061-date-standardization
 * lands — it proves the guard works (migration preview) and goes green once
 * all calling sites are migrated.
 *
 * Usage:
 *   pnpm check:dates          # fail on violations (CI gate)
 *   pnpm check:dates --list   # same + always prints violation details
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Allow-listed paths (the canonical helpers are the only legitimate home for
// these patterns — they must NOT be flagged).
// ---------------------------------------------------------------------------
const ALLOWLIST_REL: ReadonlyArray<string> = [
  'src/lib/format-date-localised.ts',
  'src/lib/format-tax-doc-date.ts',
];

// ---------------------------------------------------------------------------
// Scan roots
// ---------------------------------------------------------------------------
const SCAN_ROOTS: ReadonlyArray<string> = ['src'];
const FILE_RE = /\.(?:ts|tsx)$/;

// ---------------------------------------------------------------------------
// Banned patterns (see module JSDoc above for rationale)
// ---------------------------------------------------------------------------
interface BannedPattern {
  readonly id: string;
  readonly re: RegExp;
  readonly description: string;
}

const BANNED: ReadonlyArray<BannedPattern> = [
  {
    id: 'buddhist-literal',
    re: /['"`][^'"`]*u-ca-buddhist[^'"`]*['"`]/,
    description: "inline 'u-ca-buddhist' calendar literal — use getDateFormatLocale(locale) instead",
  },
  {
    id: 'bare-toLocaleDateString',
    // Matches: .toLocaleDateString(locale   (bare variable, not wrapped in a call)
    // Does NOT match: .toLocaleDateString(getDateFormatLocale(
    re: /\.toLocaleDateString\(\s*(?!getDateFormatLocale\s*\()(?:locale\b|[a-zA-Z_$][a-zA-Z0-9_$]*\s*[,)])/,
    description:
      '.toLocaleDateString(locale) with bare locale variable — use .toLocaleDateString(getDateFormatLocale(locale)) instead',
  },
  {
    id: 'bare-Intl-DateTimeFormat',
    // Matches: new Intl.DateTimeFormat(locale   (bare variable)
    // Does NOT match: new Intl.DateTimeFormat(getDateFormatLocale(
    // Does NOT match: new Intl.DateTimeFormat('th-TH-u-ca-buddhist'  <- ALREADY caught by buddhist-literal
    re: /new\s+Intl\.DateTimeFormat\(\s*(?!getDateFormatLocale\s*\()(?!['"`])(?:[a-zA-Z_$][a-zA-Z0-9_$]*\s*[,)])/,
    description:
      'new Intl.DateTimeFormat(locale) with bare locale variable — use new Intl.DateTimeFormat(getDateFormatLocale(locale)) instead',
  },
];

// ---------------------------------------------------------------------------
// File walker (mirrors check-fixme-budget.ts convention: fs.readdirSync
// recursive walk — no new `glob` dependency)
// ---------------------------------------------------------------------------
function* walk(root: string): Generator<string> {
  const abs = resolve(root);
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(abs, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Skip generated / vendor directories.
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
      yield* walk(full);
    } else if (st.isFile() && FILE_RE.test(name)) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------
interface Violation {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly patternId: string;
  readonly description: string;
  readonly snippet: string;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  // Single-line comment or JSDoc/block-comment continuation.
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('* ')
  );
}

function scanFile(filePath: string): ReadonlyArray<Violation> {
  const out: Violation[] = [];
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip pure comment lines (we do not want to flag documentation
    // explaining why a helper uses buddhist — only real code sites matter).
    if (isCommentLine(line)) continue;

    for (const pattern of BANNED) {
      const match = pattern.re.exec(line);
      if (match !== null) {
        out.push({
          file: filePath,
          line: i + 1,
          col: match.index + 1,
          patternId: pattern.id,
          description: pattern.description,
          snippet: line.trim().slice(0, 140),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const args = process.argv.slice(2);
  const listMode = args.includes('--list');
  const cwd = process.cwd();

  const allowlistAbs = new Set(ALLOWLIST_REL.map((p) => resolve(p)));

  const violations: Violation[] = [];

  for (const root of SCAN_ROOTS) {
    for (const filePath of walk(root)) {
      // Skip allow-listed canonical helpers.
      if (allowlistAbs.has(resolve(filePath))) continue;

      const fileViolations = scanFile(filePath);
      violations.push(...fileViolations);
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  if (violations.length === 0) {
    console.log('\x1b[32m✓ check:dates: no banned date patterns found\x1b[0m');
    return;
  }

  // Group by file for readable output.
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const rel = relative(cwd, v.file).replace(/\\/g, '/');
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(v);
  }

  console.error(`\n=== check:dates — ${violations.length} banned date pattern(s) found ===\n`);

  for (const [file, fileViolations] of byFile) {
    console.error(`  ${file}`);
    for (const v of fileViolations) {
      console.error(`    line ${v.line}:${v.col}  [${v.patternId}]`);
      console.error(`      ${v.snippet}`);
      console.error(`      → ${v.description}`);
    }
    console.error('');
  }

  console.error(
    `\x1b[31m✗ check:dates: ${violations.length} violation(s). ` +
      `Route date display through getDateFormatLocale / formatLocalisedDate ` +
      `(or formatTaxDocDate for tax docs). See src/lib/format-date-localised.ts.\x1b[0m\n`,
  );

  if (!listMode) {
    console.error(
      '  Tip: pnpm check:dates --list  shows the same output and is safe to run at any time.',
    );
    console.error('');
  }

  process.exit(1);
}

main();
