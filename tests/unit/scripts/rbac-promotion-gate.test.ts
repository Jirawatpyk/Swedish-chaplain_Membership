/**
 * T036 — D7 promotion gate for `scripts/run-migrations.ts`.
 *
 * Migration C (the super_admin promotion, file tag `rbac_v2_promotion`) must
 * NEVER apply while `FEATURE_RBAC_V2` is not `'true'`: promoting admins on the
 * OFF leg would create rows whose capability silently DEGRADES (D16 maps
 * super_admin → admin) and, worse, applying C before the flag flip breaks the
 * strictly-ordered cutover the runbook mandates. The gate refuses the whole
 * migration run BEFORE any DDL when a PENDING promotion file is detected and
 * the flag is not 'true'.
 *
 * Pure-logic tests — the fs/db reads live in run-migrations.ts; this helper
 * decides, given (files, journal, applied set, flag value), whether to refuse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  promotionGateFailure,
  RBAC_PROMOTION_TAG,
} from '../../../scripts/lib/rbac-promotion-gate';

const JOURNAL = [
  { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
  { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
  { tag: '0300_rbac_v2_promotion', when: 1798551400000 },
];

const FILES = [
  '0285_rbac_v2_role_enum.sql',
  '0286_rbac_v2_denial_audit_and_union_guard.sql',
  '0300_rbac_v2_promotion.sql',
];

/**
 * Post-remediation re-review — Migration C's system-actor exclusion is keyed on
 * the RESERVED UUID NAMESPACE (`00000000-0000-0000-0000-0000000%`) rather than an
 * enumerated id list, precisely so a future actor is covered without anyone
 * editing the migration. That only holds while every SYSTEM_ACTORS id is minted
 * inside the namespace — nothing enforced it, so an actor seeded outside it
 * would be silently PROMOTED to super_admin at cutover.
 */
describe('SYSTEM_ACTORS stay inside the reserved uuid namespace', () => {
  it('every canonical system actor matches the prefix Migration C excludes', () => {
    const src = readFileSync(
      join(process.cwd(), 'scripts', 'seed-system-actors.ts'),
      'utf-8',
    );
    const ids = [...src.matchAll(/id:\s*'([0-9a-f-]{36})'/gi)].map((m) => m[1] as string);
    expect(ids.length, 'no system-actor ids parsed — the fixture shape changed').toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `${id} sits OUTSIDE the reserved namespace and WOULD be promoted`).toMatch(
        /^00000000-0000-0000-0000-0000000/,
      );
    }
  });
});

describe('T036 D7 promotion gate', () => {
  it('exposes the naming contract Migration C must use', () => {
    expect(RBAC_PROMOTION_TAG).toBe('rbac_v2_promotion');
  });

  it('no promotion file present → proceed regardless of flag', () => {
    const files = FILES.filter((f) => !f.includes(RBAC_PROMOTION_TAG) || f.includes('role_enum') || f.includes('union_guard'));
    expect(
      promotionGateFailure({
        migrationFiles: ['0285_rbac_v2_role_enum.sql', '0286_rbac_v2_denial_audit_and_union_guard.sql'],
        journal: JOURNAL.slice(0, 2),
        appliedWhens: new Set(),
        flagValue: undefined,
      }),
    ).toBeNull();
    void files;
  });

  it('PENDING promotion + flag unset → refuse with file name + env var in the message', () => {
    const failure = promotionGateFailure({
      migrationFiles: FILES,
      journal: JOURNAL,
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: undefined,
    });
    expect(failure).not.toBeNull();
    expect(failure).toContain('0300_rbac_v2_promotion');
    expect(failure).toContain('FEATURE_RBAC_V2');
  });

  it("PENDING promotion + flag 'false' → refuse", () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'false',
      }),
    ).not.toBeNull();
  });

  it("PENDING promotion + flag 'true' → proceed (the sanctioned cutover path)", () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'true',
      }),
    ).toBeNull();
  });

  it('promotion ALREADY APPLIED + flag later deleted (PR 5) → proceed', () => {
    expect(
      promotionGateFailure({
        migrationFiles: FILES,
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000, 1798551400000]),
        flagValue: undefined,
      }),
    ).toBeNull();
  });

  it('promotion file present but MISSING from the journal → refuse (misregistration)', () => {
    const failure = promotionGateFailure({
      migrationFiles: FILES,
      journal: JOURNAL.slice(0, 2),
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: 'true',
    });
    expect(failure).not.toBeNull();
    expect(failure).toContain('journal');
  });

  /**
   * 016 PR-3 review, Important #1 — the JOURNAL-TAG bypass.
   *
   * PR 3 stages Migration C at `drizzle/migrations/pending/0287_rbac_v2_promotion.sql`
   * so ordinary deploys are not blocked. `run-migrations.ts` feeds this gate a
   * NON-RECURSIVE, `.sql`-filtered listing of the migrations root, so that file
   * is invisible here — by design.
   *
   * But drizzle's own `readMigrationFiles` resolves each journal entry as
   * `${migrationsFolder}/${entry.tag}.sql` with **no path sanitisation**. So a
   * journal entry whose tag carries the subdirectory —
   * `{ tag: 'pending/0287_rbac_v2_promotion' }` — makes the MIGRATOR apply the
   * promotion while this gate, looking only at top-level file names, sees no
   * promotion file at all and returns null.
   *
   * That is the exact scenario FR-008 / SC-006 declare technically impossible:
   * the promotion applying with `FEATURE_RBAC_V2` unset. The gate must therefore
   * derive the promotion set from the JOURNAL as well as the file listing.
   */
  it('journal tag carrying the pending/ path → refuse (D7 bypass, review Important #1)', () => {
    const failure = promotionGateFailure({
      // Top-level listing: no promotion file (it lives in pending/).
      migrationFiles: [
        '0285_rbac_v2_role_enum.sql',
        '0286_rbac_v2_denial_audit_and_union_guard.sql',
      ],
      // …but the journal points drizzle straight at it.
      journal: [
        { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
        { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
        { tag: 'pending/0287_rbac_v2_promotion', when: 1798551400000 },
      ],
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: undefined,
    });
    expect(failure, 'a path-prefixed promotion tag must not slip past the gate').not.toBeNull();
    expect(failure).toContain('FEATURE_RBAC_V2');
  });

  it('journal-tagged promotion + flag true → proceed (the bypass fix must not block the real cutover)', () => {
    expect(
      promotionGateFailure({
        migrationFiles: [
          '0285_rbac_v2_role_enum.sql',
          '0286_rbac_v2_denial_audit_and_union_guard.sql',
        ],
        journal: [
          { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
          { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
          { tag: 'pending/0287_rbac_v2_promotion', when: 1798551400000 },
        ],
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'true',
      }),
    ).toBeNull();
  });

  /**
   * 016 PR-3 review, Suggestion #2 — the silent-no-op class.
   *
   * Drizzle applies a pending entry only when `entry.when > max(applied)`. A
   * promotion journaled with a `when` at or below the global applied max is
   * skipped while the runner still prints "✓ Migrations applied" — the operator
   * believes the promotion landed and moves on. Nothing in the automated stack
   * detects it (`REQUIRED_ENUM_VALUES` is blind to a data-only migration); only
   * the runbook §5.3 hand-run SQL would catch it, after the cutover window.
   */
  it('promotion journaled with when <= applied max → refuse (silent no-op, review Suggestion #2)', () => {
    const failure = promotionGateFailure({
      migrationFiles: [...FILES],
      journal: [
        { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
        { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
        // Authored before 0286 landed and never re-validated at merge time.
        { tag: '0300_rbac_v2_promotion', when: 1798541350000 },
      ],
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: 'true',
    });
    expect(failure, 'a promotion drizzle would silently skip must be refused').not.toBeNull();
    expect(failure).toMatch(/when|silently|skip/i);
  });

  /**
   * Post-remediation re-review — the `when`-EQUALITY hole.
   *
   * The first fix keyed pending-ness on `appliedWhens.has(entry.when)`. When the
   * promotion's `when` COLLIDES with an already-applied migration's (the
   * copy-paste-the-previous-entry mistake the runbook warns about), that lookup
   * hits, `pending` is false, and BOTH refusal branches are skipped — the gate
   * waves the run through. Drizzle then compares strictly (`>`), skips the file,
   * and prints "✓ Migrations applied" while promoting nobody. The `=` half of
   * the old `when <= maxApplied` guard was provably dead code, because
   * `maxApplied` is itself always a member of `appliedWhens`.
   *
   * Boundary triple: below / equal / above the highest OTHER journal entry.
   */
  it('promotion journaled with when EQUAL to an applied migration → refuse (collision, not "already applied")', () => {
    const failure = promotionGateFailure({
      migrationFiles: [...FILES],
      journal: [
        { tag: '0285_rbac_v2_role_enum', when: 1798541300000 },
        { tag: '0286_rbac_v2_denial_audit_and_union_guard', when: 1798541400000 },
        // Copy-pasted from 0286 and never bumped.
        { tag: '0300_rbac_v2_promotion', when: 1798541400000 },
      ],
      appliedWhens: new Set([1798541300000, 1798541400000]),
      flagValue: 'true',
    });
    expect(
      failure,
      'a colliding `when` is a silent no-op, not evidence the promotion already applied',
    ).not.toBeNull();
    expect(failure).toMatch(/when|skip|greater/i);
  });

  it('promotion genuinely applied (its own when is the max) → proceed, not mistaken for a collision', () => {
    // The PR-5 state: C ran, its `when` is now in appliedWhens AND is the max.
    // The fix must not confuse this with the collision case above.
    expect(
      promotionGateFailure({
        migrationFiles: [...FILES],
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000, 1798551400000]),
        flagValue: undefined,
      }),
    ).toBeNull();
  });

  /**
   * THE STEADY STATE — and the case the 14 tests above all missed.
   *
   * Every scenario here froze the repo at the cutover instant, where C's `when`
   * happens to be the journal max. That is a moment, not a state: the next
   * feature branch that adds ANY migration makes its `when` the max, and the
   * ordering check — which is NOT gated on `pending` — starts refusing on an
   * already-applied promotion.
   *
   * The blast radius is the whole repo, not one deploy: `vercel-build` is
   * `run-migrations.ts && next build`, so prod and every preview exit 1 before
   * any DDL, and `Integration smoke` (a REQUIRED check on main) migrates a
   * fresh Neon branch, so nothing can merge either. 0282 → 0287 landed inside
   * two weeks; the fuse is short.
   *
   * The unconditional check was deliberate — it exists to catch a `when`
   * COLLISION, which `pending` cannot see (a colliding value reads as
   * "already applied"). That reasoning is right for collisions and wrong for
   * ordering, so the two split: collision stays unconditional, ordering is
   * only meaningful while the promotion is still pending.
   */
  it('promotion applied LONG AGO + a newer migration lands → proceed (the steady state)', () => {
    expect(
      promotionGateFailure({
        migrationFiles: [...FILES, '0301_some_future_feature.sql'],
        journal: [...JOURNAL, { tag: '0301_some_future_feature', when: 1798561400000 }],
        appliedWhens: new Set([1798541300000, 1798541400000, 1798551400000]),
        flagValue: 'true',
      }),
      'C is applied and is no longer the journal max — that is every day after cutover, not a fault',
    ).toBeNull();
  });

  it('promotion applied + newer migration + flag deleted (PR 5 end state) → proceed', () => {
    expect(
      promotionGateFailure({
        migrationFiles: [...FILES, '0301_some_future_feature.sql'],
        journal: [...JOURNAL, { tag: '0301_some_future_feature', when: 1798561400000 }],
        appliedWhens: new Set([1798541300000, 1798541400000, 1798551400000]),
        flagValue: undefined,
      }),
    ).toBeNull();
  });

  it('promotion journaled with when > applied max → proceed (the normal cutover)', () => {
    expect(
      promotionGateFailure({
        migrationFiles: [...FILES],
        journal: JOURNAL,
        appliedWhens: new Set([1798541300000, 1798541400000]),
        flagValue: 'true',
      }),
    ).toBeNull();
  });
});
