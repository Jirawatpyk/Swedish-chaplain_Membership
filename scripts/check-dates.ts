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
 * Multiline-aware scanning (R5):
 *   The scanner strips inline comments then runs the Intl / toLocaleDateString
 *   banned patterns over the FULL file text (not line-by-line) using `s` flag
 *   regexes so `\s*` spans newlines.  This catches calls where the bare-locale
 *   argument sits on its own line:
 *
 *     new Intl.DateTimeFormat(
 *       locale,          // ← bare arg on line N+1 — previously uncaught
 *       { year: 'numeric' }
 *     )
 *
 *   The `u-ca-buddhist` literal check is short and never written multiline, so
 *   it stays per-line (cheaper + simpler).
 *
 *   Violation line numbers are computed from the match index after stripping
 *   so they remain correct even when the stripped text differs from source in
 *   length (comment removal does not change line count; it replaces characters
 *   with spaces, keeping the newline structure intact).
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
  // Canonical helpers — the only legitimate locations for the buddhist literal.
  'src/lib/format-date-localised.ts',
  'src/lib/format-tax-doc-date.ts',

  // Email templates: server-side render for the RECIPIENT's locale (not the
  // admin's next-intl locale). Spec §4 explicitly scopes email locale handling
  // out of the BE-display convention; these use a custom BroadcastNotificationLocale
  // type with explicit tz mapping, not a bare next-intl locale variable.
  'src/modules/broadcasts/infrastructure/email/broadcast-notification-emails.ts',

  // calendar.tsx: the `locale?.code` is a react-day-picker locale OBJECT
  // property (e.g. `enUS.code`), not a next-intl locale string. The
  // toLocaleDateString call here sets a DOM data-attribute for day-picker
  // internal state, not a user-visible date string; BE conversion is
  // irrelevant (month-only calendar header has no year context where BE
  // matters, and the picker library owns its own locale formatting).
  'src/components/ui/calendar.tsx',
];

// ---------------------------------------------------------------------------
// Scan roots
// ---------------------------------------------------------------------------
const SCAN_ROOTS: ReadonlyArray<string> = ['src'];
const FILE_RE = /\.(?:ts|tsx)$/;

// ---------------------------------------------------------------------------
// Banned patterns
// ---------------------------------------------------------------------------
interface BannedPattern {
  readonly id: string;
  /** Applied per-line (for cheap literal checks). */
  readonly reLine?: RegExp;
  /**
   * Applied over full-file text (comment-stripped) with the `s` flag so
   * `\s*` spans newlines.  Used for the Intl / toLocaleDateString checks
   * that may be written multiline.
   */
  readonly reFullText?: RegExp;
  readonly description: string;
}

const BANNED: ReadonlyArray<BannedPattern> = [
  {
    id: 'buddhist-literal',
    // Short, never written multiline — keep cheap per-line check.
    reLine: /['"`][^'"`]*u-ca-buddhist[^'"`]*['"`]/,
    description: "inline 'u-ca-buddhist' calendar literal — use getDateFormatLocale(locale) instead",
  },
  {
    id: 'bare-toLocaleDateString',
    // Full-text regex with `s` flag so a multiline call like:
    //   .toLocaleDateString(
    //     locale,
    //   )
    // is caught.  The negative-lookahead (?!getDateFormatLocale\s*\() skips
    // correctly wrapped calls.
    //
    // Matches identifiers whose name IS or CONTAINS the word `locale`
    // (case-insensitive suffix match: `locale`, `userLocale`, `currentLocale`,
    // `requestLocale`, etc.) — a variable whose name derives from a locale
    // value is suspect.  Variables with unrelated names (e.g. `cacheKey`,
    // `resolvedBcp47`) that carry an already-resolved locale string are
    // explicitly NOT matched because by convention they have already been
    // through `getDateFormatLocale`.
    //
    // Also catches ternary forms: .toLocaleDateString(locale === 'th' ? 'x' : locale, …)
    reFullText:
      /\.toLocaleDateString\(\s*(?!getDateFormatLocale\s*\()(?:[a-zA-Z_$][a-zA-Z0-9_$]*[Ll]ocale\b|locale\b)/s,
    description:
      '.toLocaleDateString(locale) with bare locale variable — use .toLocaleDateString(getDateFormatLocale(locale)) instead',
  },
  {
    id: 'bare-Intl-DateTimeFormat',
    // Full-text regex so multiline Intl.DateTimeFormat calls are caught:
    //   new Intl.DateTimeFormat(
    //     locale,            ← previously escaped the per-line check
    //     { year: 'numeric' }
    //   )
    // Does NOT match: new Intl.DateTimeFormat(getDateFormatLocale(…)
    // Does NOT match: new Intl.DateTimeFormat('th-TH-u-ca-buddhist' ← buddhist-literal catches this
    // Does NOT match: new Intl.DateTimeFormat(cacheKey, …)  ← already resolved
    //
    // Matches identifiers whose name IS or CONTAINS the word `locale`
    // (same convention as bare-toLocaleDateString above).  The `locale\b`
    // branch also catches ternary forms where `locale` appears after `?`:
    //   new Intl.DateTimeFormat(locale === 'th' ? X : locale, …)
    reFullText:
      /new\s+Intl\.DateTimeFormat\(\s*(?!getDateFormatLocale\s*\()(?!['"`])(?:[a-zA-Z_$][a-zA-Z0-9_$]*[Ll]ocale\b|locale\b)/s,
    description:
      'new Intl.DateTimeFormat(locale) with bare locale variable — use new Intl.DateTimeFormat(getDateFormatLocale(locale)) instead',
  },
];

// ---------------------------------------------------------------------------
// Comment stripper
//
// Replaces comment text with spaces so:
//   - line numbers are preserved (newlines untouched)
//   - patterns inside comments are never flagged
//
// Handles:
//   - /* … */  block comments (including /** JSDoc */)
//   - // … EOL  single-line comments
// ---------------------------------------------------------------------------
function stripComments(source: string): string {
  // Block comments first (may span multiple lines).
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  // Single-line comments.
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

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

/**
 * Compute the 1-based line number of `matchIndex` within `text`.
 * Counts newline characters before the match position.
 */
function lineOf(text: string, matchIndex: number): number {
  let line = 1;
  for (let i = 0; i < matchIndex; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function scanFile(filePath: string): ReadonlyArray<Violation> {
  const out: Violation[] = [];
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  // --- Per-line pass (for the cheap `buddhist-literal` literal check) ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;

    for (const pattern of BANNED) {
      if (!pattern.reLine) continue;
      const match = pattern.reLine.exec(line);
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

  // --- Full-text pass (for multiline Intl / toLocaleDateString patterns) ---
  const stripped = stripComments(source);

  for (const pattern of BANNED) {
    if (!pattern.reFullText) continue;

    // Use a sticky/global copy to find ALL matches (not just the first).
    const globalRe = new RegExp(pattern.reFullText.source, 'gs');
    let match: RegExpExecArray | null;
    while ((match = globalRe.exec(stripped)) !== null) {
      const lineNum = lineOf(stripped, match.index);
      const lineText = lines[lineNum - 1] ?? '';
      // Compute column from the character offset within that line.
      const lineStart = match.index - (stripped.lastIndexOf('\n', match.index - 1) + 1);
      out.push({
        file: filePath,
        line: lineNum,
        col: lineStart + 1,
        patternId: pattern.id,
        description: pattern.description,
        snippet: lineText.trim().slice(0, 140),
      });
    }
  }

  // Deduplicate: a pattern that has BOTH reLine and reFullText would fire
  // twice on the same location.  Keep the first occurrence per (line, patternId).
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.line}:${v.patternId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
