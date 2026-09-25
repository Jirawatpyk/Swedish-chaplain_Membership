/**
 * #400 PR-B item 9 — the positive control behind `pnpm check:multi-tenant`.
 *
 * The readiness check audits RLS + FORCE + a tenant policy on an ALLOW-LIST
 * (`SCOPED_TABLES`), which is the right shape for a gate but has one blind
 * spot: a table that is never added to the list is never checked, and the
 * gate reports OK. Fifteen `tenant_id` tables were in exactly that state when
 * this control was written (all fifteen turned out to carry RLS + FORCE + a
 * policy; they had simply never been registered).
 *
 * So this module parses every Drizzle table that DECLARES a `tenant_id`
 * column and demands that each one is registered somewhere — `SCOPED_TABLES`
 * (checked), `LEGACY_KNOWN_GAPS` (reported), or `EXEMPT` (with a reason). It
 * refuses a parse that found NOTHING, and one that missed a table known to
 * exist: a check that cannot tell "nothing to find" from "not looking" is not
 * a check (CLAUDE.md § Gotchas — the `check:f8-error-id` lesson).
 *
 * CRLF-safe by construction: nothing here anchors on a line ending. Each
 * schema file is comment-stripped, split on `pgTable(`, and every chunk is
 * searched for the `'tenant_id'` column literal.
 *
 * Pure except `readSchemaSources` (filesystem only — never the database), so
 * the unit test feeds it strings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripCommentsPreserveLines } from './source-scan';

export interface SchemaSource {
  readonly path: string;
  readonly text: string;
}

/** A table registered as intentionally outside the RLS contract, and why. */
export interface ExemptTable {
  readonly table: string;
  readonly reason: string;
}

export interface CoverageLists {
  readonly scoped: readonly string[];
  readonly legacy: readonly string[];
  readonly exempt: readonly ExemptTable[];
}

/**
 * The parse: every `tenant_id` table found, by name — and every `pgTable(`
 * that declares `tenant_id` under a name that is NOT a string literal (a
 * constant, a template), which cannot be matched against the registry and is
 * a failure, never a silent skip (#400 W4).
 */
export interface ParsedTenantTables {
  readonly tables: readonly string[];
  /** The source path of each unnamed `tenant_id` table. */
  readonly unnamed: readonly string[];
}

export interface CoverageResult {
  /** Every `tenant_id` table the parse found, sorted. */
  readonly parsed: readonly string[];
  /** Human-readable failures; empty ⇒ pass. */
  readonly failures: readonly string[];
}

/**
 * Tables that exist for certain — if the parse does not find them, the parse
 * is broken (a changed Drizzle idiom, a moved schema directory), not the
 * schema.
 */
export const KNOWN_TENANT_TABLES: readonly string[] = ['members', 'broadcasts', 'invoices'];

const TABLE_NAME = /^\s*['"]([a-z0-9_]+)['"]/;
const TENANT_COLUMN = /['"]tenant_id['"]/;

/** Every Drizzle table in `sources` whose definition declares a `tenant_id` column. */
export function parseTenantScopedTables(sources: readonly SchemaSource[]): ParsedTenantTables {
  const found = new Set<string>();
  const unnamed: string[] = [];
  for (const { path, text } of sources) {
    const chunks = stripCommentsPreserveLines(text).split('pgTable(');
    // chunks[0] is everything before the first table.
    for (const chunk of chunks.slice(1)) {
      if (!TENANT_COLUMN.test(chunk)) continue;
      const name = TABLE_NAME.exec(chunk)?.[1];
      if (name === undefined) unnamed.push(path);
      else found.add(name);
    }
  }
  return { tables: [...found].sort(), unnamed };
}

/** The positive control: every parsed table registered, and the parse not blind. */
export function checkCoverage(parse: ParsedTenantTables, lists: CoverageLists): CoverageResult {
  const failures: string[] = [];
  const parsed = parse.tables;
  for (const path of parse.unnamed) {
    failures.push(
      `a pgTable( in ${path} declares tenant_id but its name is not a string literal — ` +
        'the control cannot match it against the registry; name the table with a literal',
    );
  }
  if (parsed.length === 0 && parse.unnamed.length === 0) {
    failures.push('the schema parse found ZERO tenant_id tables — the parse is blind, not the schema clean');
  }
  for (const known of KNOWN_TENANT_TABLES) {
    if (parsed.length > 0 && !parsed.includes(known)) {
      failures.push(`the schema parse did not find \`${known}\`, a table known to exist — the parse is broken`);
    }
  }
  const registered = new Set([...lists.scoped, ...lists.legacy, ...lists.exempt.map((e) => e.table)]);
  for (const table of parsed) {
    if (!registered.has(table)) {
      failures.push(
        `\`${table}\` declares tenant_id but is in none of SCOPED_TABLES, LEGACY_KNOWN_GAPS or EXEMPT — ` +
          'verify its RLS + FORCE + policy and register it',
      );
    }
  }
  for (const e of lists.exempt) {
    if (e.reason.trim() === '') failures.push(`EXEMPT entry \`${e.table}\` has no reason`);
  }
  return { parsed: [...parsed], failures };
}

/** Every `*.ts` file under `src/modules/**\/infrastructure/**` that calls `pgTable(`. */
export function readSchemaSources(root: string): SchemaSource[] {
  const out: SchemaSource[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        if (text.includes('pgTable(')) out.push({ path: relative(root, full), text });
      }
    }
  };
  const modules = join(root, 'src', 'modules');
  for (const mod of readdirSync(modules)) {
    const infra = join(modules, mod, 'infrastructure');
    try {
      if (statSync(infra).isDirectory()) walk(infra);
    } catch {
      // A Domain-only module (e.g. tenants) has no infrastructure directory.
    }
  }
  return out;
}
