/**
 * Enum-migration guard — pure helpers shared by `scripts/run-migrations.ts`.
 *
 * ── WHY THIS EXISTS (prod incident 2026-07-04) ───────────────────────────────
 *   The deploy pipeline applies Drizzle migrations through the drizzle-orm
 *   postgres-js migrator (`drizzle-orm/postgres-js/migrator`). That migrator
 *   wraps the ENTIRE pending batch in ONE transaction
 *   (`PgDialect.migrate` → `session.transaction(async (tx) => { … })`) — putting
 *   a value into `drizzle.__drizzle_migrations` (the applied-tracking table) in
 *   the same transaction as the SQL.
 *
 *   PostgreSQL rule: a value added by `ALTER TYPE … ADD VALUE` on a *pre-existing*
 *   enum type (one committed by an earlier deploy) cannot be safely USED later in
 *   the same transaction, and — as CONFIRMED on prod for migration 0230 — does
 *   not reliably persist through this transactional migrator. Result: 0230 was
 *   recorded as applied in `__drizzle_migrations`, but `document_type += 'bill'`,
 *   `+= 'receipt_105'`, and `audit_event_type += 'tax_receipt_issued'` never
 *   landed, and the 088 new-flow issue path 500'd with
 *   `invalid input value for enum document_type: "bill"`.
 *
 *   The exception PostgreSQL DOES allow: using a new value of an enum type that
 *   was CREATED earlier in the *same* transaction. That is why fresh-DB /
 *   per-PR-preview deploys never broke — the type and its new values are created
 *   together in one migrate() transaction. Only databases where the enum type
 *   pre-existed (prod) hit the bug.
 *
 * ── THE FIX (see run-migrations.ts) ──────────────────────────────────────────
 *   Run every `ALTER TYPE … ADD VALUE` in AUTOCOMMIT *before* the transactional
 *   migrate() pass, so the value is committed in its own prior transaction. Then
 *   the transactional pass's `ADD VALUE IF NOT EXISTS` is a no-op and any later
 *   migration that uses the value is safe. A post-migrate assertion then verifies
 *   the code-required enum values actually exist and fails the build loudly if
 *   not — so a half-applied enum can never silently ship again.
 *
 * This module holds only PURE, side-effect-free helpers so the detection and
 * assertion logic can be unit-tested without a database.
 */

/**
 * Matches a single `ALTER TYPE [schema.]name ADD VALUE [IF NOT EXISTS] 'literal'
 * [BEFORE|AFTER 'other'];` statement. Whitespace-tolerant; supports optional
 * double-quoting and an optional schema qualifier; tolerates SQL-escaped quotes
 * (`''`) inside the literal. Captures through the trailing semicolon so the
 * statement can be replayed verbatim in autocommit.
 */
export const ALTER_TYPE_ADD_VALUE_RE =
  /ALTER\s+TYPE\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'(?:[^'\n]|'')*'(?:\s+(?:BEFORE|AFTER)\s+'(?:[^'\n]|'')*')?\s*;/gi;

/**
 * Removes whole-line SQL comments (lines whose first non-whitespace characters
 * are `--`). This prevents a commented-out or documentation `ALTER TYPE … ADD
 * VALUE` example (e.g. the prose header of migration 0230) from being extracted
 * and executed. Inline trailing comments after a statement are naturally
 * excluded because {@link ALTER_TYPE_ADD_VALUE_RE} ends at the first `;`.
 */
export function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * Extracts every `ALTER TYPE … ADD VALUE` statement from a migration file's SQL
 * (ignoring commented lines), trimmed and ready to replay verbatim.
 */
export function extractAlterTypeAddValueStatements(sql: string): string[] {
  const matches = stripLineComments(sql).match(ALTER_TYPE_ADD_VALUE_RE);
  return matches === null ? [] : matches.map((statement) => statement.trim());
}

/**
 * The enum values the running application code depends on. The post-migrate
 * assertion verifies each enum type in the database is a SUPERSET of the values
 * listed here. Extend this map when a new code path starts to depend on a
 * freshly-added enum value.
 *
 * Keep values in sync with the enum labels in `drizzle/migrations/*.sql`:
 *   - `document_type`   base 'invoice','receipt','credit_note' (0019)
 *                       + 'bill','receipt_105' (0230)
 *   - `audit_event_type` += 'tax_receipt_issued' (0230)
 *                        += 'members_backup_exported' (0237)
 *                        += 'renewal_cycle_reanchored' (0238)
 *                        += 'membership_suspended_action_blocked',
 *                           'membership_access_fail_open',
 *                           'broadcast_membership_suspended_blocked' (0245)
 *                        += 'renewal_lapse_deferred_invoice_not_due' (0246)
 */
export const REQUIRED_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  document_type: ['invoice', 'receipt', 'credit_note', 'bill', 'receipt_105'],
  audit_event_type: [
    'tax_receipt_issued',
    'members_backup_exported',
    'renewal_cycle_reanchored',
    'membership_suspended_action_blocked',
    'membership_access_fail_open',
    'broadcast_membership_suspended_blocked',
    'renewal_lapse_deferred_invoice_not_due',
  ],
};

export interface MissingEnumValues {
  readonly enumType: string;
  /** false when the enum type itself is absent from the database. */
  readonly typeExists: boolean;
  readonly missing: readonly string[];
}

/**
 * Pure comparison: given the enum values actually present in the database
 * (`enumType -> set of labels`) and the required set, returns the required
 * values that are missing. An enum type absent from `present` reports all of its
 * required values as missing with `typeExists: false`.
 */
export function findMissingEnumValues(
  present: ReadonlyMap<string, ReadonlySet<string>>,
  required: Readonly<Record<string, readonly string[]>> = REQUIRED_ENUM_VALUES,
): MissingEnumValues[] {
  const result: MissingEnumValues[] = [];
  for (const [enumType, requiredValues] of Object.entries(required)) {
    const presentValues = present.get(enumType);
    const missing = requiredValues.filter((value) => !presentValues?.has(value));
    if (missing.length > 0) {
      result.push({ enumType, typeExists: presentValues !== undefined, missing });
    }
  }
  return result;
}

/**
 * Builds a clear, actionable failure message for a failed post-migrate enum
 * assertion — names each missing value and gives the idempotent hand-fix.
 */
export function formatMissingEnumValuesError(
  missing: readonly MissingEnumValues[],
): string {
  const lines: string[] = [
    'Post-migrate enum assertion FAILED — required enum value(s) are missing from the database.',
    'An `ALTER TYPE … ADD VALUE` migration likely did not persist through the transactional',
    'drizzle migrator (see scripts/lib/enum-migration-guard.ts header for the full story).',
    '',
  ];
  for (const entry of missing) {
    lines.push(
      entry.typeExists
        ? `  • enum "${entry.enumType}" is missing: ${entry.missing.join(', ')}`
        : `  • enum type "${entry.enumType}" does not exist (expected: ${entry.missing.join(', ')})`,
    );
  }
  lines.push('', 'Hand-fix (autocommit, idempotent):', '  pnpm tsx scripts/repair-enum-drift.ts');
  lines.push('or apply the specific value(s) directly against the unpooled connection:');
  for (const entry of missing) {
    for (const value of entry.missing) {
      lines.push(`  ALTER TYPE "${entry.enumType}" ADD VALUE IF NOT EXISTS '${value}';`);
    }
  }
  return lines.join('\n');
}
