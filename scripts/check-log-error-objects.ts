#!/usr/bin/env tsx
/**
 * `pnpm check:log-error-objects` — Spec 140 s2d (#736c). No log line in the
 * members or broadcasts module carries an error OBJECT or error TEXT
 * (`.message`, `.stack`, `String(e)`, a raw `cause`): drizzle-orm's
 * `DrizzleQueryError` has enumerable `query` and `params`, so either one
 * writes the statement's bound parameters — emails, names, payloads — to the
 * log. The rule is `scripts/lib/log-error-objects-rules.ts` (TypeScript
 * compiler API, CRLF- and multi-line-proof); this file is only the I/O.
 *
 * Allowed values: the explicit safe callees (`errKind(…)`, `pgErrorCode(…)`,
 * `pgErrorMeta(…)`, `errLogFields(…)`, `hashId(…)`, … — the set in the rule),
 * `classifyThrown(…).kind`, `.code` / `.kind` / `.name` of an error, and
 * identifiers named `code` or ending in `Code` / `Kind` / `Class` that are not
 * a caught binding nor a local read off an error (review round 2: one hop, or
 * a local annotated with a `TOKEN_FIELDS_BY_TYPE` type). `logger.child(…)`
 * arguments are read too.
 *
 * A TRIPWIRE, not proof of completeness: it reads each `logger.<level>(…)`
 * call syntactically, so text laundered through a call into a local, two
 * locals, or an unknown helper first passes. There is no pragma; reduce the
 * value to a token, or annotate a reviewed class field.
 *
 * Positive control: `scripts/__fixtures__/log-error-objects.fixture.txt`
 * holds every refused form, one per line marked `// refused`, and allowed
 * forms marked `// allowed`. The gate FAILS if the fixture yields no finding,
 * if a `// refused` line yields none, or if an `// allowed` line yields one —
 * so a rule that rots cannot pass silently over the real tree.
 *
 * Scope: `src/modules/members/**` and `src/modules/broadcasts/**` `.ts`
 * files, tests excluded. Follow-up: the same rule for the other modules and
 * `src/app` (see the s2d PR).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { findLogErrorObjects, scanLogErrorObjects } from './lib/log-error-objects-rules';

const ROOTS = ['src/modules/members', 'src/modules/broadcasts'] as const;
const FIXTURE = 'scripts/__fixtures__/log-error-objects.fixture.txt';
/** A floor, not a pin: the scope rotting to a handful of files must fail loudly. */
const MIN_FILES_PER_ROOT = 50;
/**
 * Review round 1 — a floor on the logger calls the rule PARSED in the real
 * tree: a parse that silently stops recognising logger calls must fail
 * loudly, not pass at zero findings.
 */
const MIN_LOGGER_CALLS = 300;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full.split('\\').join('/'));
    }
  }
  return out;
}

const failures: string[] = [];

// --- positive control -------------------------------------------------------
const fixture = readFileSync(FIXTURE, 'utf8');
const fixtureFindings = findLogErrorObjects(FIXTURE, fixture);
const flagged = new Set(fixtureFindings.map((f) => f.line));
const fixtureLines = fixture.split(/\r?\n/);
let refusedMarked = 0;
fixtureLines.forEach((text, i) => {
  const line = i + 1;
  if (/\/\/ refused\s*$/.test(text)) {
    refusedMarked += 1;
    if (!flagged.has(line)) failures.push(`POSITIVE CONTROL: ${FIXTURE}:${line} is a refused form the rule no longer finds:\n    ${text.trim()}`);
  } else if (/\/\/ allowed\s*$/.test(text) && flagged.has(line)) {
    failures.push(`POSITIVE CONTROL: ${FIXTURE}:${line} is an allowed form the rule now refuses:\n    ${text.trim()}`);
  }
});
if (fixtureFindings.length === 0 || refusedMarked === 0) {
  failures.push(`POSITIVE CONTROL: ${FIXTURE} yielded ${fixtureFindings.length} finding(s) over ${refusedMarked} marked line(s); the rule is inert.`);
}

// --- the real tree ----------------------------------------------------------
let fileCount = 0;
let loggerCalls = 0;
for (const root of ROOTS) {
  const files = walk(root, []);
  if (files.length < MIN_FILES_PER_ROOT) {
    failures.push(`SCOPE: ${root} matched ${files.length} file(s) (expected >= ${MIN_FILES_PER_ROOT}); the scope has rotted.`);
  }
  fileCount += files.length;
  for (const file of files) {
    const scan = scanLogErrorObjects(file, readFileSync(file, 'utf8'));
    loggerCalls += scan.loggerCalls;
    for (const f of scan.findings) {
      failures.push(`${file}:${f.line}\n    ${f.message}`);
    }
  }
}
if (loggerCalls < MIN_LOGGER_CALLS) {
  failures.push(
    `FLOOR: the rule parsed ${loggerCalls} logger call(s) in the real tree (expected >= ${MIN_LOGGER_CALLS}); the parse has rotted.`,
  );
}

if (failures.length > 0) {
  console.error(`\n✗ check:log-error-objects — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'A log line carries an error as `err: errKind(e)` (or `errKind(rootCause(x.error))` for a\n' +
      'RepoError, plus `repoCode: x.error.code`), `code: pgErrorCode(e)`, `pgErrorMeta(e)`, or a\n' +
      "gateway's `classifyThrown(e).kind` — never the object, its cause, or its message\n" +
      '(docs/observability.md § Log hygiene).\n',
  );
  process.exit(1);
}

console.log(
  `✓ check:log-error-objects — ${fileCount} file(s) and ${loggerCalls} logger call(s) in members + broadcasts, no error object or text in a log line; ` +
    `${refusedMarked} refused form(s) in the positive control, each found.`,
);
