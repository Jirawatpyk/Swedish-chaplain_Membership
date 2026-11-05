/**
 * Spec 140 s2d (#736b) — the stuck rule of a tenant audience orphan as SQL:
 * the same rule as the Domain's `isOrphanStuck` (`orphaned-resend-id.ts`),
 * from a cutoff the caller passes in (`orphanStuckCutoff(asOf)`), never the
 * database `now()`.
 *
 * `created_at` is truncated to milliseconds: the driver hands the app a
 * millisecond `Date`, so a row 0.4 ms past the cutoff is stuck to
 * `isOrphanStuck`, and the SQL must say so too.
 *
 * It takes SQL fragments, not columns, so the detach arm's raw SQL can pass
 * its alias (`capped.attempts`). The caller chooses ASC or DESC. Its own file:
 * the orphans repo already imports from `drizzle-broadcasts-repo.ts`, so a
 * helper in either repo would make an import cycle.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ORPHAN_STUCK_ATTEMPTS } from '../../domain/value-objects/orphaned-resend-id';

export function orphanStuckSql(attempts: SQL, createdAt: SQL, cutoff: Date): SQL {
  return sql`(${attempts} >= ${ORPHAN_STUCK_ATTEMPTS}::int AND date_trunc('milliseconds', ${createdAt}) <= ${cutoff.toISOString()}::timestamptz)`;
}
