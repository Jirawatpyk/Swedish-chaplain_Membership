/**
 * Generic anti-drift parity assertion for TS literal-tuple unions ↔
 * Postgres enum types. Extracted from the F7 notification-type +
 * audit-event-type parity tests (PR #19) so F4/F5/future features can
 * adopt the pattern without re-implementing the pg_enum query +
 * bidirectional set-difference logic.
 *
 * Why bidirectional:
 *   - TS-missing-from-SQL: a TS-side enum value added without a matching
 *     migration → runtime INSERT fails with "invalid input value for
 *     enum X". Caught by `missingInSql`.
 *   - SQL-missing-from-TS: a hand-written or auto-applied migration
 *     added an enum value without the TS union being updated → emit
 *     sites with the new value silently fall through default branches.
 *     Caught by `missingInTs`.
 *
 * F7 PR #19 demonstrated that this test catches REAL drift: migration
 * 0079 (`broadcast_delivered_notification`) was claimed-applied in an
 * earlier session but had not actually run on live Neon. The parity
 * test surfaced it before runtime.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle', 'migrations');

/**
 * Every value THIS working tree's migrations declare for `typeName`.
 *
 * Needed because the dev Neon branch is SHARED across feature branches. A
 * sibling branch that applies its own migration adds enum values the current
 * tree has never heard of, and the SQL→TS direction then reports drift that
 * the current branch cannot fix — the value belongs to someone else's TS
 * union, and adding it here would ship a TS reference to an enum value that
 * this branch's migrations do not create (fine on the shared dev DB, broken
 * the moment this branch merges to main alone).
 *
 * Comparing against the tree's own migrations separates the two cases:
 *   - declared here + missing from TS  → REAL drift, this branch's bug
 *   - not declared here                → a sibling branch's value, not ours
 *
 * Matches both declaration forms used in this repo:
 *   ALTER TYPE "x" ADD VALUE [IF NOT EXISTS] 'value'
 *   CREATE TYPE "x" AS ENUM ('a', 'b', …)
 */
export function enumValuesDeclaredByMigrations(typeName: string): Set<string> {
  const out = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const q = `"?${typeName}"?`;
  const addValue = new RegExp(
    `ALTER\\s+TYPE\\s+${q}\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'([^']+)'`,
    'gi',
  );
  const createEnum = new RegExp(
    `CREATE\\s+TYPE\\s+${q}\\s+AS\\s+ENUM\\s*\\(([^)]*)\\)`,
    'gi',
  );
  for (const f of files) {
    const sqlText = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8');
    for (const m of sqlText.matchAll(addValue)) out.add(m[1]!);
    for (const m of sqlText.matchAll(createEnum)) {
      for (const lit of m[1]!.matchAll(/'([^']+)'/g)) out.add(lit[1]!);
    }
  }
  return out;
}

export interface EnumParityOpts {
  /** Postgres enum type name (e.g. `'audit_event_type'`, `'notification_type'`). */
  readonly typeName: string;

  /**
   * The complete list of enum values the TS layer expects. Typically
   * derived from a literal-tuple `as const` array (e.g.
   * `F7_AUDIT_EVENT_TYPES`) OR from `Object.keys()` of an exhaustive
   * `Record<UnionType, …>` map (F4 + F5 use the latter pattern via
   * their `*_AUDIT_RETENTION_YEARS` maps).
   */
  readonly tsValues: ReadonlyArray<string>;

  /**
   * Predicate filtering `pg_enum.enumlabel` rows to the TS-tracked
   * subset. Required when the enum is shared across features
   * (e.g. `audit_event_type` is used by F1+F2+F3+F4+F5+F7) — without
   * a filter the SQL→TS direction would falsely flag every other
   * feature's events as drift.
   *
   * For SIMPLE cases (literal prefix list + explicit labels) prefer
   * the declarative `prefixes` + `extraInclude` + `extraExclude`
   * options below — the predicate is internally derived from them so
   * you don't write the lambda yourself. Use `sqlScopeFilter` for
   * cases that don't fit the declarative shape (regex, version-suffix
   * matching, dynamic membership).
   *
   * Mutually exclusive with the declarative options — supply ONE
   * form. If both are supplied, `sqlScopeFilter` wins (predicate is
   * more specific).
   *
   * If neither is supplied, the entire enum is treated as in-scope
   * (only correct when the enum is single-feature).
   */
  readonly sqlScopeFilter?: (enumLabel: string) => boolean;

  /**
   * Declarative scope: enum labels that START WITH any of these
   * strings are considered in-scope. Matches `String.prototype.startsWith`
   * (no regex / glob — pass a literal prefix). Use for the common case
   * where a feature's events all share a stable namespace.
   *
   * Example (F4 invoicing):
   *   `prefixes: ['invoice_', 'credit_note_', 'receipt_', 'tenant_invoice_settings_', 'pdf_render_']`
   */
  readonly prefixes?: ReadonlyArray<string>;

  /**
   * Explicit additional in-scope labels that don't match any
   * `prefixes` entry but still belong to the feature (legacy names,
   * cross-feature events with the wrong namespace).
   *
   * Example (F4 invoicing): `extraInclude: ['auto_email_delivery_failed']`
   */
  readonly extraInclude?: ReadonlyArray<string>;

  /**
   * Explicit out-of-scope labels — useful when a `prefixes` entry
   * accidentally overlaps another feature's namespace. Applied AFTER
   * `prefixes` + `extraInclude` so it can carve out exceptions.
   */
  readonly extraExclude?: ReadonlyArray<string>;
}

/**
 * Resolve the scope predicate from the (predicate | declarative) options.
 * Predicate wins if both are supplied (more specific). Returns
 * `undefined` if no filter was specified — caller treats the entire
 * enum as in-scope (single-feature enums).
 *
 * Exported for unit testing (review PR #20 round-2 #2).
 */
export function resolveScopeFilter(
  opts: EnumParityOpts,
): ((label: string) => boolean) | undefined {
  // Detect conflicting options — predicate is going to win, but the
  // contributor likely meant only one form. Warn so the silent
  // precedence rule is observable in test output (review PR #20
  // round-2 #1).
  const declarativeSupplied =
    opts.prefixes !== undefined ||
    opts.extraInclude !== undefined ||
    opts.extraExclude !== undefined;
  if (opts.sqlScopeFilter !== undefined && declarativeSupplied) {
    console.warn(
      `[assertEnumParity] both \`sqlScopeFilter\` predicate AND declarative options ` +
        `(prefixes/extraInclude/extraExclude) were supplied for enum "${opts.typeName}". ` +
        `The predicate wins; declarative options are ignored. Pick ONE form to silence this warning.`,
    );
  }
  if (opts.sqlScopeFilter !== undefined) return opts.sqlScopeFilter;
  if (!declarativeSupplied) return undefined;
  const prefixes = opts.prefixes ?? [];
  const includeSet = new Set<string>(opts.extraInclude ?? []);
  const excludeSet = new Set<string>(opts.extraExclude ?? []);
  return (label: string): boolean => {
    if (excludeSet.has(label)) return false;
    if (includeSet.has(label)) return true;
    return prefixes.some((p) => label.startsWith(p));
  };
}

export interface EnumParityResult {
  readonly missingInSql: ReadonlyArray<string>; // TS values not in pg_enum
  readonly missingInTs: ReadonlyArray<string>; // pg_enum values not in TS (post-filter)
  /**
   * `missingInTs` values that a migration IN THIS TREE declares — genuine
   * drift the current branch owns and must fix. Assert on THIS, not on
   * `missingInTs`, when running against the shared dev Neon branch.
   */
  readonly missingInTsDeclaredHere: ReadonlyArray<string>;
  /**
   * `missingInTs` values with NO declaring migration in this tree: a sibling
   * feature branch applied its migration to the shared dev database. Not
   * actionable here — adding them to this branch's TS union would reference an
   * enum value this branch's migrations never create.
   */
  readonly missingInTsForeign: ReadonlyArray<string>;
  readonly tsCount: number;
  readonly sqlCount: number; // post-filter
}

/**
 * Query `pg_enum` for the named type, optionally filter to the
 * caller-tracked subset, and compute set differences against `tsValues`.
 *
 * Returns an `EnumParityResult` — caller asserts `missingInSql` +
 * `missingInTs` are both empty arrays (e.g. via
 * `expect({missingInSql, missingInTs}).toEqual({missingInSql: [], missingInTs: []})`
 * so failures show both directions in one diff).
 */
export async function getEnumParity(
  opts: EnumParityOpts,
): Promise<EnumParityResult> {
  const rows = (await db.execute(sql`
    SELECT enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = ${opts.typeName}
    ORDER BY enumsortorder
  `)) as unknown as Array<{ enumlabel: string }>;

  const scopeFilter = resolveScopeFilter(opts);
  const filtered = scopeFilter
    ? rows.filter((r) => scopeFilter(r.enumlabel))
    : rows;

  const sqlValues = new Set(filtered.map((r) => r.enumlabel));
  const tsValues = new Set<string>(opts.tsValues);

  const missingInSql: string[] = [];
  for (const tsv of tsValues) {
    if (!sqlValues.has(tsv)) missingInSql.push(tsv);
  }
  const missingInTs: string[] = [];
  for (const sv of sqlValues) {
    if (!tsValues.has(sv)) missingInTs.push(sv);
  }

  const declaredHere = enumValuesDeclaredByMigrations(opts.typeName);
  const missingInTsDeclaredHere = missingInTs.filter((v) => declaredHere.has(v));
  const missingInTsForeign = missingInTs.filter((v) => !declaredHere.has(v));

  if (missingInTsForeign.length > 0) {
    console.warn(
      `[assertEnumParity] "${opts.typeName}": the shared dev database carries ` +
        `${missingInTsForeign.length} in-scope value(s) that NO migration in this ` +
        `tree declares — ${JSON.stringify(missingInTsForeign)}. A sibling feature ` +
        `branch applied its migration to the same database. Not drift in THIS ` +
        `branch, and not fixable here: adding them to this TS union would ` +
        `reference enum values this branch's migrations never create. They will ` +
        `resolve when the owning branch merges.`,
    );
  }

  return {
    missingInSql,
    missingInTs,
    missingInTsDeclaredHere,
    missingInTsForeign,
    tsCount: tsValues.size,
    sqlCount: sqlValues.size,
  };
}
