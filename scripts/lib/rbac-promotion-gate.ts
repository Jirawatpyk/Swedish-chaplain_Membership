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
  // Derive the promotion set from BOTH sources, because they can disagree and
  // each one alone is bypassable (016 PR-3 review, Important #1):
  //
  //   - The FILE listing `run-migrations.ts` supplies is a non-recursive,
  //     `.sql`-filtered read of the migrations root. Migration C is deliberately
  //     staged one directory down (`pending/`) so ordinary deploys are not
  //     blocked, which means it does NOT appear here.
  //   - Drizzle's own `readMigrationFiles` resolves each journal entry as
  //     `${migrationsFolder}/${entry.tag}.sql` with **no path sanitisation**. A
  //     journal entry tagged `pending/0287_rbac_v2_promotion` therefore makes
  //     the MIGRATOR apply the promotion, while a file-only gate sees nothing
  //     and waves the run through — the promotion applying with the flag unset,
  //     which FR-008 / SC-006 declare technically impossible.
  //
  // Keying on the tag (not the path) covers both the sanctioned top-level file
  // and any subdirectory-tagged shortcut.
  const candidates = new Map<string, string>(); // tag → display name
  for (const file of input.migrationFiles) {
    if (file.includes(RBAC_PROMOTION_TAG)) candidates.set(file.replace(/\.sql$/, ''), file);
  }
  for (const entry of input.journal) {
    if (entry.tag.includes(RBAC_PROMOTION_TAG)) {
      candidates.set(entry.tag, `${entry.tag}.sql`);
    }
  }
  if (candidates.size === 0) return null;

  // Drizzle applies a pending entry only when its `when` STRICTLY exceeds every
  // applied one, so a promotion journaled at or below the current max is SKIPPED
  // while the runner still prints "✓ Migrations applied" (016 PR-3 review,
  // Suggestion #2). Nothing else in the automated stack detects that:
  // `REQUIRED_ENUM_VALUES` is blind to a data-only migration.
  //
  // COLLISION and ORDERING are two different faults and are checked separately.
  //
  // The collision check must be UNCONDITIONAL, because a `when` copy-pasted from
  // an already-applied migration is exactly the case `pending` cannot see: the
  // lookup hits, `pending` reads false, and a promotion drizzle will silently
  // skip sails through.
  //
  // The ordering check must be gated on `pending`, because "strictly newer than
  // every sibling" is only a requirement while the promotion is still WAITING to
  // apply. Once it has applied, the repo keeps adding migrations and one of them
  // becomes the journal max within days — a fact about time passing, not a
  // fault. An earlier revision made ordering unconditional to close the equality
  // hole above; that armed a delayed repo-wide freeze. `run-migrations.ts` runs
  // as `vercel-build` (prod + every preview) and inside the REQUIRED
  // `Integration smoke` check, so a refusal here stops deploys AND merges.
  // Splitting the two closes the hole without the fuse.
  const maxOtherJournalWhen = (tag: string): number => {
    let max = -Infinity;
    for (const j of input.journal) {
      if (j.tag !== tag && j.when > max) max = j.when;
    }
    return max;
  };

  for (const [tag, file] of candidates) {
    const entry = input.journal.find((j) => j.tag === tag);
    if (!entry) {
      return (
        `D7 promotion gate: '${file}' is present but has no journal entry — ` +
        `register it in drizzle/migrations/meta/_journal.json (a promotion ` +
        `file drizzle cannot see would silently never apply).`
      );
    }
    const collidesWith = input.journal.find((j) => j.tag !== tag && j.when === entry.when);
    if (collidesWith) {
      return (
        `D7 promotion gate: '${file}' is journaled with when=${entry.when}, which ` +
        `COLLIDES with '${collidesWith.tag}'. Drizzle compares strictly, so it ` +
        `would SKIP this migration while still reporting "✓ Migrations applied", ` +
        `and a value equal to an already-applied one additionally reads as ` +
        `"already applied". Bump its 'when' above the journal max ` +
        `(docs/runbooks/rbac-v2-cutover.md § 5 step 1).`
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
    const highestSibling = maxOtherJournalWhen(tag);
    if (pending && entry.when <= highestSibling) {
      return (
        `D7 promotion gate: '${file}' is PENDING and journaled with ` +
        `when=${entry.when}, which is NOT strictly greater than every other ` +
        `journal entry (highest sibling: ${highestSibling}). Drizzle compares ` +
        `strictly, so it would SKIP this migration while still reporting ` +
        `"✓ Migrations applied" — the promotion would silently never run. Bump ` +
        `its 'when' above the journal max ` +
        `(docs/runbooks/rbac-v2-cutover.md § 5 step 1).`
      );
    }
  }
  return null;
}
