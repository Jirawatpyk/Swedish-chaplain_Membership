#!/usr/bin/env tsx
/**
 * `pnpm check:process-docs` — the review rules live only in their owner,
 * `review-and-ship` § 1 (D-043). The rule is `scripts/lib/process-docs.ts`;
 * this file only lists the tracked Markdown it reads.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { findProcessDocViolations, REVIEW_RULES_OWNER } from './lib/process-docs';

// The process docs: the skills, agents, workflows and rules under `.claude/`,
// `docs/`, the PR template and the root CLAUDE.md. Agent memory is a local
// cache, not a process doc.
const paths = execFileSync('git', ['ls-files', '--', '.claude/*.md', 'docs/*.md', '.github/*.md', 'CLAUDE.md'], {
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter((p) => p !== '' && !p.startsWith('.claude/agent-memory/'));

const files = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
if (!files.some((f) => f.path === REVIEW_RULES_OWNER)) {
  console.error(`check:process-docs: the owner ${REVIEW_RULES_OWNER} is not tracked — the gate checked nothing`);
  process.exit(1);
}

const { restated, missingFromOwner } = findProcessDocViolations(files);
if (missingFromOwner.length > 0) {
  console.error(`check:process-docs: ${REVIEW_RULES_OWNER} no longer carries:`);
  for (const p of missingFromOwner) console.error(`  "${p}"`);
  console.error('A rule was reworded: update REVIEW_RULE_PHRASES in scripts/lib/process-docs.ts to the new sentence.');
  process.exit(1);
}
if (restated.length > 0) {
  console.error(`check:process-docs: ${restated.length} review rule(s) restated outside ${REVIEW_RULES_OWNER}:`);
  for (const r of restated) console.error(`  ${r.path}: "${r.phrase}"`);
  console.error('Link to `review-and-ship` § 1 instead of restating the rule (D-043).');
  process.exit(1);
}
console.log(`check:process-docs: ${files.length} process docs, the review rules live only in ${REVIEW_RULES_OWNER}`);
