#!/usr/bin/env tsx
/**
 * F5 scope-gate: every admin + portal `page.tsx` and `loading.tsx` MUST
 * import exactly one of TableContainer / FormContainer / DetailContainer
 * from `@/components/layout`.
 *
 * Additionally, a page.tsx and its sibling loading.tsx MUST use the SAME
 * container type — otherwise the skeleton→content transition causes CLS
 * (Spec §FR-007).
 *
 * Fails with non-zero exit if any file imports zero or multiple
 * containers, or if a page+loading pair disagrees.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOTS = ['src/app/(staff)', 'src/app/(member)'];
const CONTAINERS = ['TableContainer', 'FormContainer', 'DetailContainer'] as const;
type Container = (typeof CONTAINERS)[number];
const CONTAINER_RE = /\b(TableContainer|FormContainer|DetailContainer)\b/g;
const LAYOUT_IMPORT_RE =
  /import\s*\{[^}]+\}\s*from\s*['"]@\/components\/layout(?:\/[^'"]+)?['"]/g;

// Redirect-only page detection.
//   - imports `redirect` from `next/navigation`
//   - calls `redirect(`
const REDIRECT_IMPORT_RE =
  /import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*['"]next\/navigation['"]/;
const REDIRECT_CALL_RE = /\bredirect\s*\(/;
// A real page returns a JSX tree: `return (` followed (soon) by `<`.
// Used as the negative guard so a real page that *conditionally* redirects
// while ALSO rendering a layout is NOT mistaken for a redirect-only page.
const JSX_RETURN_RE = /return\s*\(\s*</;

type Offense =
  | { kind: 'count'; file: string; found: Container[]; reason: 'zero' | 'multiple' }
  | { kind: 'pair-mismatch'; page: string; loading: string; pageVariant: Container; loadingVariant: Container }
  | { kind: 'pair-missing'; page: string; loading: string };

function collectFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const entries = readdirSync(resolve(root), { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name === 'page.tsx' || e.name === 'loading.tsx') {
        out.push(resolve(join((e as { parentPath?: string; path?: string }).parentPath ?? (e as { path: string }).path, e.name)));
      }
    }
  }
  return out;
}

function findContainers(source: string): Container[] {
  const found = new Set<Container>();
  for (const block of source.match(LAYOUT_IMPORT_RE) ?? []) {
    for (const m of block.matchAll(CONTAINER_RE)) found.add(m[1] as Container);
  }
  return [...found];
}

/**
 * A redirect-only page renders NO layout — it exists purely to preserve a
 * route for email/bookmark deep-links and `redirect()` the visitor onward
 * (058 D2 consolidated several portal surfaces into hubs; the legacy routes
 * stay alive only as redirects, e.g. /portal/benefits/e-blasts →
 * /portal/benefits?tab=broadcasts and /portal/preferences/renewals →
 * /portal/account#renewal-prefs). Such a page has no container to require, so
 * it is exempt from the layout-container rule.
 *
 * The heuristic is deliberately PRECISE so it never exempts a real page that
 * conditionally calls `redirect()` while ALSO rendering a layout (e.g.
 * admin/plans/new redirects after a successful create but otherwise renders a
 * FormContainer). A file is redirect-only ONLY when ALL hold:
 *   1. it imports `redirect` from `next/navigation`, AND
 *   2. it contains a `redirect(` call, AND
 *   3. it imports ZERO layout containers, AND
 *   4. it returns NO JSX tree (`return (` followed by `<`).
 * If a file imports a container OR returns JSX, it is a real page and stays
 * subject to the container requirement.
 */
function isRedirectOnlyPage(
  source: string,
  containers: Container[],
): boolean {
  return (
    containers.length === 0 &&
    REDIRECT_IMPORT_RE.test(source) &&
    REDIRECT_CALL_RE.test(source) &&
    !JSX_RETURN_RE.test(source)
  );
}

function main(): void {
  const files = collectFiles();
  if (files.length === 0) {
    console.error('check:layout — no page.tsx/loading.tsx files matched. Check ROOTS.');
    process.exit(2);
  }

  const offenses: Offense[] = [];
  const variantByFile = new Map<string, Container>();

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const found = findContainers(src);
    // Redirect-only pages render no layout — skip the container requirement
    // (and the page+loading pairing check, since they have no loading.tsx).
    if (isRedirectOnlyPage(src, found)) continue;
    if (found.length === 0) offenses.push({ kind: 'count', file, found, reason: 'zero' });
    else if (found.length > 1) offenses.push({ kind: 'count', file, found, reason: 'multiple' });
    else variantByFile.set(file, found[0]!);
  }

  // Cross-check: each page.tsx must have a sibling loading.tsx, and they
  // must share a variant. Missing loading.tsx is a CLS-0 hazard per FR-007
  // (skeleton-to-content shift) — fail loudly so silent deletions are
  // caught at pre-push, not in production.
  const allFiles = new Set(files);
  for (const [file, variant] of variantByFile) {
    if (!file.endsWith('page.tsx')) continue;
    const loading = join(dirname(file), 'loading.tsx');
    if (!allFiles.has(loading)) {
      offenses.push({ kind: 'pair-missing', page: file, loading });
      continue;
    }
    const loadingVariant = variantByFile.get(loading);
    if (loadingVariant && loadingVariant !== variant) {
      offenses.push({
        kind: 'pair-mismatch',
        page: file,
        loading,
        pageVariant: variant,
        loadingVariant,
      });
    }
  }

  if (offenses.length > 0) {
    console.error(`check:layout — ${offenses.length} offending file(s):\n`);
    for (const o of offenses) {
      if (o.kind === 'count') {
        console.error(`  ${relative(process.cwd(), o.file)}`);
        console.error(
          `    reason: ${
            o.reason === 'zero'
              ? 'no layout container imported'
              : `multiple containers imported: ${o.found.join(', ')}`
          }`,
        );
      } else if (o.kind === 'pair-mismatch') {
        console.error(`  ${relative(process.cwd(), o.page)} uses ${o.pageVariant}`);
        console.error(`  ${relative(process.cwd(), o.loading)} uses ${o.loadingVariant}`);
        console.error(`    reason: page and loading must use the SAME container (FR-007 CLS 0)`);
      } else {
        console.error(`  ${relative(process.cwd(), o.page)}`);
        console.error(`  ${relative(process.cwd(), o.loading)} (missing)`);
        console.error(`    reason: every migrated page.tsx must have a sibling loading.tsx (FR-007)`);
      }
    }
    console.error(
      `\nEvery page.tsx and loading.tsx must import exactly one of: ${CONTAINERS.join(', ')}.`,
    );
    console.error(
      `page.tsx and its sibling loading.tsx must use the same container type.`,
    );
    process.exit(1);
  }

  console.log(
    `check:layout — OK (${files.length} page/loading files; pairs consistent).`,
  );
}

main();
