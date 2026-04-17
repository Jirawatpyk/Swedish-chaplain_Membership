#!/usr/bin/env tsx
/**
 * F5 scope-gate: every admin + portal `page.tsx` MUST import exactly one of
 * TableContainer / FormContainer / DetailContainer from `@/components/layout`.
 *
 * Fails with non-zero exit if any page imports zero or multiple of them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOTS = ['src/app/(staff)', 'src/app/(member)'];
const CONTAINERS = ['TableContainer', 'FormContainer', 'DetailContainer'] as const;

type Offense = { file: string; found: string[]; reason: 'zero' | 'multiple' };

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (s.isFile() && name === 'page.tsx') out.push(full);
  }
}

function collectFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(resolve(root), out);
  return out;
}

function findContainers(source: string): string[] {
  const found = new Set<string>();
  const importBlocks =
    source.match(/import\s*\{[^}]+\}\s*from\s*['"]@\/components\/layout[^'"]*['"]/g) ?? [];
  for (const block of importBlocks) {
    for (const name of CONTAINERS) {
      if (new RegExp(`\\b${name}\\b`).test(block)) found.add(name);
    }
  }
  return [...found];
}

function main(): void {
  const files = collectFiles();
  if (files.length === 0) {
    console.error('check:layout — no page.tsx files matched. Check ROOTS.');
    process.exit(2);
  }

  const offenses: Offense[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const found = findContainers(src);
    if (found.length === 0) offenses.push({ file, found, reason: 'zero' });
    else if (found.length > 1) offenses.push({ file, found, reason: 'multiple' });
  }

  if (offenses.length > 0) {
    console.error(`check:layout — ${offenses.length} offending page(s):\n`);
    for (const o of offenses) {
      const rel = relative(process.cwd(), o.file);
      console.error(`  ${rel}`);
      console.error(
        `    reason: ${
          o.reason === 'zero'
            ? 'no layout container imported'
            : `multiple containers imported: ${o.found.join(', ')}`
        }`,
      );
    }
    console.error(`\nEvery page.tsx must import exactly one of: ${CONTAINERS.join(', ')}.`);
    process.exit(1);
  }

  console.log(
    `check:layout — OK (${files.length} pages each import exactly one layout container).`,
  );
}

main();
