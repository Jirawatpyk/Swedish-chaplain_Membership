/**
 * 108 T003 / research V1 — read-only primary-contact inventory (counts only).
 *
 * Migration `0293` installs a deferred CONSTRAINT TRIGGER that refuses any
 * commit leaving an active, non-erased member with a number of live primary
 * contacts other than one. Its pre-check DO block FAILS THE DEPLOY when the
 * data already violates the invariant, so PR-B must not merge until this
 * script prints `violations: 0`. Re-run it immediately before the merge — the
 * first run (2026-09-04) is only a snapshot.
 *
 * PRIVACY: prints COUNTS and member ids only — never an email, a name or any
 * other contact PII (Constitution Principle I; the operator runs this against
 * production). It opens no write path: a single SELECT inside `runInTenant`.
 *
 * Usage (prod, read-only):
 *   node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts
 * Dev branch:
 *   node --env-file=.env.local --import tsx scripts/inventory-primary-contact-invariant.ts
 *
 * Exit code 0 = invariant holds (safe to apply 0293); 1 = violations found —
 * remedy per quickstart § "Before PR-B merges" (promote a remaining contact
 * through the normal member page; never hand-edit rows), then re-run.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

interface InventoryRow {
  readonly zero_primary: number;
  readonly multi_primary: number;
  readonly active_non_erased_members: number;
  readonly primaries: number;
  readonly secondaries: number;
  readonly secondaries_with_login: number;
  readonly marketing_unsubscribes: number;
}

/** Members whose live-primary count is not exactly 1, ids only (no PII). */
interface ViolationRow {
  readonly member_id: string;
  readonly live_primaries: number;
}

async function main(): Promise<void> {
  const tenantId = process.env.INVENTORY_TENANT_ID ?? 'swecham';
  console.log('');
  console.log('=== 108 V1 — primary-contact inventory (read-only, counts only) ===');
  console.log(`tenant: ${tenantId}`);
  console.log('');

  const { counts, violations } = await runInTenant(
    asTenantContext(tenantId),
    async (tx) => {
      // One pass over the live contact rows per member; `live` = not removed.
      // The invariant is scoped to members that can still receive money email:
      // active/inactive (i.e. not archived) and not erased.
      const countRows = (await tx.execute(sql`
        WITH live AS (
          SELECT c.member_id,
                 COUNT(*) FILTER (WHERE c.is_primary)                       AS primaries,
                 COUNT(*) FILTER (WHERE NOT c.is_primary)                   AS secondaries,
                 COUNT(*) FILTER (WHERE NOT c.is_primary AND c.linked_user_id IS NOT NULL)
                                                                            AS secondaries_with_login
            FROM contacts c
           WHERE c.tenant_id = ${tenantId}
             AND c.removed_at IS NULL
           GROUP BY c.member_id
        ), scoped AS (
          SELECT m.member_id, COALESCE(l.primaries, 0) AS primaries
            FROM members m
            LEFT JOIN live l ON l.member_id = m.member_id
           WHERE m.tenant_id = ${tenantId}
             AND m.status <> 'archived'
             AND m.erased_at IS NULL
        )
        SELECT
          (SELECT COUNT(*) FROM scoped WHERE primaries = 0)::int              AS zero_primary,
          (SELECT COUNT(*) FROM scoped WHERE primaries > 1)::int              AS multi_primary,
          (SELECT COUNT(*) FROM scoped)::int                                  AS active_non_erased_members,
          (SELECT COALESCE(SUM(primaries), 0) FROM live)::int                 AS primaries,
          (SELECT COALESCE(SUM(secondaries), 0) FROM live)::int               AS secondaries,
          (SELECT COALESCE(SUM(secondaries_with_login), 0) FROM live)::int    AS secondaries_with_login,
          (SELECT COUNT(*) FROM marketing_unsubscribes u
            WHERE u.tenant_id = ${tenantId})::int                             AS marketing_unsubscribes
      `)) as unknown as InventoryRow[];

      const violationRows = (await tx.execute(sql`
        SELECT m.member_id,
               (SELECT COUNT(*)::int
                  FROM contacts c
                 WHERE c.tenant_id = m.tenant_id
                   AND c.member_id = m.member_id
                   AND c.removed_at IS NULL
                   AND c.is_primary) AS live_primaries
          FROM members m
         WHERE m.tenant_id = ${tenantId}
           AND m.status <> 'archived'
           AND m.erased_at IS NULL
           AND (SELECT COUNT(*)
                  FROM contacts c
                 WHERE c.tenant_id = m.tenant_id
                   AND c.member_id = m.member_id
                   AND c.removed_at IS NULL
                   AND c.is_primary) <> 1
         ORDER BY m.member_id
         LIMIT 200
      `)) as unknown as ViolationRow[];

      return { counts: countRows[0], violations: violationRows };
    },
  );

  if (counts === undefined) {
    console.error('No rows returned — check the tenant id and the connection.');
    process.exitCode = 1;
    return;
  }

  const violationCount = counts.zero_primary + counts.multi_primary;
  console.log(`members (active/inactive, non-erased): ${counts.active_non_erased_members}`);
  console.log(`  with zero live primaries:            ${counts.zero_primary}`);
  console.log(`  with more than one live primary:     ${counts.multi_primary}`);
  console.log(`live contacts — primaries:             ${counts.primaries}`);
  console.log(`live contacts — secondaries:           ${counts.secondaries}`);
  console.log(`  of those, with a portal login:       ${counts.secondaries_with_login}`);
  console.log(`marketing_unsubscribes rows:           ${counts.marketing_unsubscribes}`);
  console.log('');
  console.log(`violations: ${violationCount}`);

  if (violationCount > 0) {
    console.log('');
    console.log('Member ids to fix (promote a remaining contact on the member page):');
    for (const row of violations) {
      console.log(`  ${row.member_id}  live_primaries=${row.live_primaries}`);
    }
    if (violations.length === 200) {
      console.log('  … truncated at 200 ids.');
    }
    console.log('');
    console.log('Migration 0293 will REFUSE to apply while this is non-zero.');
    process.exitCode = 1;
    return;
  }

  console.log('Invariant holds — migration 0293 (PR-B) is safe to apply.');
}

void main().catch((error: unknown) => {
  console.error('inventory failed:', error);
  process.exitCode = 1;
});
