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
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

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

  return {
    missingInSql,
    missingInTs,
    tsCount: tsValues.size,
    sqlCount: sqlValues.size,
  };
}
