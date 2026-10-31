#!/usr/bin/env tsx
/**
 * `pnpm check:process-docs` — each process rule lives only in its owner:
 * the review rules in `review-and-ship` § 1 (D-043), the Verify rule in
 * `feature-flow` § 6 (D-044). The rule is `scripts/lib/process-docs.ts`; this
 * file only lists the tracked Markdown it reads.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { findProcessDocViolations, RULE_SETS } from './lib/process-docs';

// The process docs: the skills, agents, workflows and rules under `.claude/`,
// `docs/`, the PR template and the root CLAUDE.md. Agent memory is a local
// cache, not a process doc. `-z`: NUL-separated and unquoted, so a non-ASCII
// file name (a Thai runbook title) reaches readFileSync as-is, not C-quoted.
const paths = execFileSync('git', ['ls-files', '-z', '--', '.claude/*.md', 'docs/*.md', '.github/*.md', 'CLAUDE.md'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter((p) => p !== '' && !p.startsWith('.claude/agent-memory/'));

const files = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const ownerOf = (phrase: string) => RULE_SETS.find((r) => r.phrases.includes(phrase))?.owner ?? '?';
for (const set of RULE_SETS) {
  if (!files.some((f) => f.path === set.owner)) {
    console.error(`check:process-docs: the owner ${set.owner} is not tracked — the gate checked nothing`);
    process.exit(1);
  }
}

const { restated, missingFromOwner } = findProcessDocViolations(files);
if (missingFromOwner.length > 0) {
  console.error('check:process-docs: an owner no longer carries one of its listed phrases:');
  for (const p of missingFromOwner) console.error(`  ${ownerOf(p)}: "${p}"`);
  console.error('A rule was reworded: update its phrase list in scripts/lib/process-docs.ts to the new sentence.');
  process.exit(1);
}
if (restated.length > 0) {
  console.error(`check:process-docs: ${restated.length} rule phrase(s) restated outside their owner:`);
  for (const r of restated) console.error(`  ${r.path}: "${r.phrase}" (owner: ${ownerOf(r.phrase)})`);
  console.error('Link to the owner instead of restating the rule (D-043, D-044).');
  process.exit(1);
}
console.log(`check:process-docs: ${files.length} process docs, each rule lives only in its owner (${RULE_SETS.map((r) => r.owner).join(', ')})`);
