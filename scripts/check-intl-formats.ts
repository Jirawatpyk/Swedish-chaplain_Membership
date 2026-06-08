#!/usr/bin/env tsx
/**
 * next-intl preset-name typo guard — prevents runtime silent fallbacks when
 * a `.dateTime(date, 'presetName')` call uses a preset that does not exist in
 * `buildFormats`. The next-intl library has no compile-time check for preset
 * names in v4.x; a typo (e.g. 'dateMedum') compiles fine but falls back to
 * Intl defaults at runtime, silently losing the Buddhist-Era calendar for `th`.
 *
 * What it checks:
 *   Scans src/**\/*.ts|tsx files for .dateTime() calls whose LAST argument is a
 *   string literal (single or double quoted).  These are the preset-name usages.
 *   Inline-options calls (.dateTime(date, { year: 'numeric' })) are NOT
 *   matched and are safe to ignore — they bypass the named-format path entirely.
 *
 * Valid preset names are derived at runtime from `buildFormats('en').dateTime`
 * keys so that adding a new preset automatically expands the allowlist.
 *
 * Enforcement model:
 *   Exits 1 on violations (file:line + preset name + allowed set printed).
 *   In `.husky/pre-push` it runs alongside the other advisory `check:*`
 *   guards (check:layout, check:fixme, check:dates) — none chained with
 *   `|| exit 1`, so a failure is visible but non-blocking in pre-push.
 *   It IS blocking in the full-CI reproduce command:
 *     pnpm lint && … && pnpm check:intl-formats && …
 *
 * Usage:
 *   pnpm check:intl-formats         # exit 1 on violations
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildFormats } from '../src/i18n/formats';

// ---------------------------------------------------------------------------
// Derive valid preset names from the canonical source at runtime.
// `buildFormats('en').dateTime` has all keys; th/sv share the same key set.
// ---------------------------------------------------------------------------
const VALID_PRESETS = new Set(Object.keys(buildFormats('en').dateTime));

// ---------------------------------------------------------------------------
// Scan roots + file filter
// ---------------------------------------------------------------------------
const SCAN_ROOTS: ReadonlyArray<string> = ['src'];
const FILE_RE = /\.(?:ts|tsx)$/;

// ---------------------------------------------------------------------------
// Regex: matches a `.dateTime(` call whose last argument before `)` is a
// string literal (single or double quoted).  The captured group is the
// preset name string.
//
// Pattern breakdown:
//   \.dateTime\(          — method call
//   .*                    — any arguments before the preset (greedy so we
//                           reach the LAST comma, even when earlier args
//                           contain nested parens like `new Date()`)
//   ,\s*                  — last comma + optional whitespace
//   ['"]([A-Za-z0-9_]+)['"] — quoted preset name (captured)
//   \s*\)                 — optional whitespace + closing paren
//
// Greedy `.*` ensures the match reaches the LAST `,` before the preset,
// correctly handling first args like `new Date()` that themselves contain `)`.
//
// This deliberately does NOT match `.dateTime(date, { … })` inline-object
// calls because `{` does not start a quoted string literal.
// ---------------------------------------------------------------------------
const PRESET_CALL_RE = /\.dateTime\(.*,\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;

// ---------------------------------------------------------------------------
// Comment-line heuristic (cheap per-line skip before running the regex)
// ---------------------------------------------------------------------------
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('* ')
  );
}

// ---------------------------------------------------------------------------
// File walker (same convention as check-dates.ts / check-fixme-budget.ts)
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
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
      yield* walk(full);
    } else if (st.isFile() && FILE_RE.test(name)) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Violation type
// ---------------------------------------------------------------------------
interface Violation {
  readonly file: string;
  readonly line: number;
  readonly preset: string;
}

// ---------------------------------------------------------------------------
// Per-file scanner
// ---------------------------------------------------------------------------
function scanFile(filePath: string, relPath: string): ReadonlyArray<Violation> {
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue;

    // Reset lastIndex before each line scan (global regex is stateful).
    PRESET_CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRESET_CALL_RE.exec(line)) !== null) {
      const preset = match[1]!;
      if (!VALID_PRESETS.has(preset)) {
        violations.push({ file: relPath, line: i + 1, preset });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const cwd = process.cwd();
  const violations: Violation[] = [];
  let filesScanned = 0;

  for (const root of SCAN_ROOTS) {
    for (const filePath of walk(root)) {
      const relPath = relative(cwd, filePath).replace(/\\/g, '/');
      const fileViolations = scanFile(filePath, relPath);
      violations.push(...fileViolations);
      filesScanned++;
    }
  }

  if (violations.length === 0) {
    const validList = [...VALID_PRESETS].join(', ');
    console.log(
      `\x1b[32m✓ check:intl-formats: all .dateTime() preset names are valid` +
        ` (${filesScanned} files scanned; valid: ${validList})\x1b[0m`,
    );
    return;
  }

  const validList = [...VALID_PRESETS].join(', ');
  console.error(
    `\n=== check:intl-formats — ${violations.length} invalid preset name(s) found ===\n`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  preset '${v.preset}' is not in: ${validList}`,
    );
  }
  console.error(
    `\n\x1b[31m✗ check:intl-formats: fix the preset name(s) above.` +
      ` Valid names come from buildFormats() in src/i18n/formats.ts\x1b[0m\n`,
  );
  process.exit(1);
}

main();
