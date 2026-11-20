#!/usr/bin/env tsx
/**
 * `pnpm check:log-error-objects` — Spec 140 s2d (#736c). No log line in the
 * scanned root carries an error OBJECT or error TEXT
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
 * Scope: `src/modules/**`, `src/app/**` and `src/lib/**` `.ts`/`.tsx` files, tests excluded (#740 B1
 * and B2). Since B2 the call sites of every `LOG_WRAPPERS` entry are read
 * too, and a listed wrapper that no longer reaches a log line fails the run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  findCaughtErrorLiterals,
  findLogErrorObjects,
  LOG_WRAPPERS,
  scanLogErrorObjects,
} from './lib/log-error-objects-rules';

const ROOTS = [
  // #740: every module (B1 swept invoicing, payments, events and renewals; the
  // B2 review added auth, plans, insights and tenants), then the route
  // handlers, pages and composition helpers (B2).
  'src/modules',
  'src/app',
  'src/lib',
] as const;
/**
 * #739 B3b — the files directly under `src/` (`src/proxy.ts`): no directory
 * root holds them, so the proxy's log lines went unread. No per-root floor.
 */
const TOP_LEVEL_DIR = 'src';
const FIXTURE = 'scripts/__fixtures__/log-error-objects.fixture.txt';
/** #739 B3a — the positive control and the shrink-only baseline of the caught-literal rule. */
const CAUGHT_FIXTURE = 'scripts/__fixtures__/caught-error-literals.fixture.txt';
const CAUGHT_BASELINE = 'scripts/caught-error-literals-baseline.json';
/** A floor, not a pin: the scope rotting to a handful of files must fail loudly. */
const MIN_FILES_PER_ROOT = 50;
/**
 * Review round 1 — a floor on the logger calls the rule PARSED in the real
 * tree: a parse that silently stops recognising logger calls must fail
 * loudly, not pass at zero findings.
 */
const MIN_LOGGER_CALLS = 1600;

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

// #739 B3a — the caught-literal rule's own positive control.
const caughtFixture = readFileSync(CAUGHT_FIXTURE, 'utf8');
const caughtFlagged = new Set(findCaughtErrorLiterals(CAUGHT_FIXTURE, caughtFixture).map((f) => f.line));
let caughtRefusedMarked = 0;
caughtFixture.split(/\r?\n/).forEach((text, i) => {
  const line = i + 1;
  if (/\/\/ refused\s*$/.test(text)) {
    caughtRefusedMarked += 1;
    if (!caughtFlagged.has(line)) failures.push(`POSITIVE CONTROL: ${CAUGHT_FIXTURE}:${line} is a refused form the rule no longer finds:\n    ${text.trim()}`);
  } else if (/\/\/ allowed\s*$/.test(text) && caughtFlagged.has(line)) {
    failures.push(`POSITIVE CONTROL: ${CAUGHT_FIXTURE}:${line} is an allowed form the rule now refuses:\n    ${text.trim()}`);
  }
});
if (caughtFlagged.size === 0 || caughtRefusedMarked === 0) {
  failures.push(`POSITIVE CONTROL: ${CAUGHT_FIXTURE} yielded ${caughtFlagged.size} finding(s); the caught-literal rule is inert.`);
}
const caughtBaseline = (JSON.parse(readFileSync(CAUGHT_BASELINE, 'utf8')) as { files: Record<string, number> }).files;
const caughtSeen = new Map<string, number>();

// --- the real tree ----------------------------------------------------------
let fileCount = 0;
let loggerCalls = 0;
const discovered = new Set<string>();
for (const root of ROOTS) {
  const files = walk(root, []);
  if (files.length < MIN_FILES_PER_ROOT) {
    failures.push(`SCOPE: ${root} matched ${files.length} file(s) (expected >= ${MIN_FILES_PER_ROOT}); the scope has rotted.`);
  }
  fileCount += files.length;
  for (const file of files) {
    const scan = scanLogErrorObjects(file, readFileSync(file, 'utf8'));
    loggerCalls += scan.loggerCalls;
    for (const w of scan.wrappers) discovered.add(`${w.name}:${w.index}`);
    for (const f of scan.findings) {
      failures.push(`${file}:${f.line}\n    ${f.message}`);
    }
    const caught = findCaughtErrorLiterals(file, readFileSync(file, 'utf8'));
    if (caught.length > 0) caughtSeen.set(file, caught.length);
    if (caught.length > (caughtBaseline[file] ?? 0)) {
      for (const f of caught) failures.push(`${file}:${f.line}\n    ${f.message} (caught-literal rule, #739)`);
    }
  }
}
const topLevel = readdirSync(TOP_LEVEL_DIR)
  .filter((f) => /\.tsx?$/.test(f) && !/\.(?:test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  .map((f) => `${TOP_LEVEL_DIR}/${f}`);
if (!topLevel.includes('src/proxy.ts')) failures.push(`SCOPE: ${TOP_LEVEL_DIR}/proxy.ts is no longer scanned; the top-level scope has rotted.`);
for (const file of topLevel) {
  fileCount += 1;
  const scan = scanLogErrorObjects(file, readFileSync(file, 'utf8'));
  loggerCalls += scan.loggerCalls;
  for (const w of scan.wrappers) discovered.add(`${w.name}:${w.index}`);
  for (const f of scan.findings) failures.push(`${file}:${f.line}\n    ${f.message}`);
  const caught = findCaughtErrorLiterals(file, readFileSync(file, 'utf8'));
  if (caught.length > 0) caughtSeen.set(file, caught.length);
  if (caught.length > (caughtBaseline[file] ?? 0)) {
    for (const f of caught) failures.push(`${file}:${f.line}\n    ${f.message} (caught-literal rule, #739)`);
  }
}
// #739 B3a — the baseline only shrinks: a file that needs fewer sites lowers its count.
for (const [file, count] of Object.entries(caughtBaseline)) {
  const now = caughtSeen.get(file) ?? 0;
  if (now < count) {
    failures.push(`BASELINE: ${CAUGHT_BASELINE} lists ${count} site(s) for ${file}, which now has ${now}; lower it (it only shrinks).`);
  }
}
const caughtRemaining = [...caughtSeen.values()].reduce((a, b) => a + b, 0);
// #740 B2 — a listed wrapper that no longer puts that argument in a log line is stale.
const wrapperCount = Object.keys(LOG_WRAPPERS).length;
for (const [name, indexes] of Object.entries(LOG_WRAPPERS)) {
  for (const index of indexes) {
    if (!discovered.has(`${name}:${index}`)) {
      failures.push(`LOG_WRAPPERS: \`${name}: [${index}]\` no longer reaches a log line in the real tree; remove it.`);
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
      '(docs/observability.md § Log hygiene). Outside a log line, a catch block puts a caught\n' +
      "error in a Result, body, span or column as `errKind(e)` or a closed code, never its text (#739).\n",
  );
  process.exit(1);
}

console.log(
  `✓ check:log-error-objects — ${fileCount} file(s) and ${loggerCalls} logger call(s) in ${ROOTS.length} root(s) plus ${topLevel.length} top-level file(s) and the call sites of ${wrapperCount} log wrapper(s), no error object or text in a log line; ` +
    `${refusedMarked} refused form(s) in the positive control, each found; ` +
    `caught-literal rule: ${caughtRemaining} baselined site(s) left for B3b, ${caughtRefusedMarked} refused form(s) in its control.`,
);
