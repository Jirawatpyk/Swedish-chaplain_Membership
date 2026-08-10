/**
 * T036 — D7 promotion gate (016-rbac-permissions).
 *
 * Pure decision logic; `run-migrations.ts` supplies the fs/db reads. See the
 * test file for the contract and `docs/runbooks/rbac-v2-cutover.md` § 5 for
 * the operational sequence this enforces.
 */

export const RBAC_PROMOTION_TAG = 'rbac_v2_promotion';

export interface PromotionGateInput {
  /** `.sql` file names present in `drizzle/migrations/`. */
  readonly migrationFiles: readonly string[];
  /** Journal entries from `meta/_journal.json`. */
  readonly journal: ReadonlyArray<{ readonly tag: string; readonly when: number }>;
  /** `when` values recorded as applied in `drizzle.__drizzle_migrations`. */
  readonly appliedWhens: ReadonlySet<number>;
  /** Raw `process.env.FEATURE_RBAC_V2`. */
  readonly flagValue: string | undefined;
}

/** Returns a human-readable refusal, or `null` when migration may proceed. */
export function promotionGateFailure(input: PromotionGateInput): string | null {
  const promotionFiles = input.migrationFiles.filter((f) => f.includes(RBAC_PROMOTION_TAG));
  if (promotionFiles.length === 0) return null;

  for (const file of promotionFiles) {
    const tag = file.replace(/\.sql$/, '');
    const entry = input.journal.find((j) => j.tag === tag);
    if (!entry) {
      return (
        `D7 promotion gate: '${file}' is present but has no journal entry — ` +
        `register it in drizzle/migrations/meta/_journal.json (a promotion ` +
        `file drizzle cannot see would silently never apply).`
      );
    }
    const pending = !input.appliedWhens.has(entry.when);
    if (pending && input.flagValue !== 'true') {
      return (
        `D7 promotion gate: '${file}' is PENDING but FEATURE_RBAC_V2 is ` +
        `'${input.flagValue ?? '(unset)'}'. Migration C must only apply AFTER ` +
        `the flag flip (docs/runbooks/rbac-v2-cutover.md § 5). Refusing to ` +
        `migrate before any DDL ran.`
      );
    }
  }
  return null;
}
