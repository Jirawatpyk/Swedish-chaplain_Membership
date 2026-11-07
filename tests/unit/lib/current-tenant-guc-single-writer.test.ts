/**
 * Spec 143, review round 1 (code-review #2) — `runInTenant` in `src/lib/db.ts`
 * is the only writer of `app.current_tenant` in `src/`.
 *
 * The broadcasts audience audit skips its tenant probe on a tx it has already
 * proven (`assertAudienceAuditTenantBoundTx`, `drizzle-broadcasts-repo.ts`).
 * That skip is sound only while the GUC is written once per tx, by
 * `runInTenant`, before `bindTenantTx` registers the tx. A second writer
 * anywhere in `src/` (a `SET`, `SET LOCAL`, `SET SESSION` or `set_config` of
 * the GUC) could change a registered tx's tenant after its probe, so this scan
 * fails on one.
 *
 * Comments are stripped first: docblocks across `src/` quote the statement.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRITER = 'src/lib/db.ts';

/** The four write forms, case-insensitive. */
const WRITE_FORMS: readonly RegExp[] = [
  /\bSET\s+(?:LOCAL\s+|SESSION\s+)?"?app\.current_tenant\b/i,
  /\bset_config\s*\(\s*['"]app\.current_tenant['"]/i,
];

/** Block and line comments out; a `//` inside a quoted string (a URL) is kept. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

function writes(source: string): number {
  const code = stripComments(source);
  return WRITE_FORMS.reduce((n, re) => n + (code.match(new RegExp(re.source, 'gi'))?.length ?? 0), 0);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

function writersInSrc(): Record<string, number> {
  const root = process.cwd();
  const found: Record<string, number> = {};
  for (const full of walk(join(root, 'src'))) {
    const n = writes(readFileSync(full, 'utf8'));
    if (n > 0) found[relative(root, full).split(sep).join('/')] = n;
  }
  return found;
}

describe('review round 1 — app.current_tenant has one writer in src/ (runInTenant)', () => {
  it('src/ writes the GUC only in src/lib/db.ts, once', () => {
    expect(writersInSrc()).toEqual({ [WRITER]: 1 });
  });

  it.each([
    ['SET LOCAL', "await tx.execute(sql.raw(`SET LOCAL app.current_tenant = '${slug}'`));"],
    ['SET', 'await tx.execute(sql`SET app.current_tenant = ${slug}`);'],
    ['SET SESSION, lower case', "await db.execute(sql.raw(`set session app.current_tenant to 'x'`));"],
    ['a quoted name', 'await tx.execute(sql.raw(`SET LOCAL "app.current_tenant" = \'x\'`));'],
    ['set_config', "await tx.execute(sql`SELECT set_config('app.current_tenant', ${slug}, true)`);"],
  ])('catch case: %s is a write', (_name, line) => {
    expect(writes(line)).toBe(1);
  });

  it('a read, or a comment that quotes the statement, is not a write', () => {
    expect(writes("sql`SELECT current_setting('app.current_tenant', TRUE) AS t`")).toBe(0);
    expect(writes('/** `SET LOCAL app.current_tenant = <slug>` */\n// SET LOCAL app.current_tenant = x')).toBe(0);
  });
});
