/**
 * #717 review (code-review #9) — "this member's erasure has its completion
 * record": ONE SQL fragment for every reader, so the admin erase, the
 * reconciler's stuck query and the erasure status page cannot drift apart.
 *
 * The `audit_log` tenant filter is LOAD-BEARING: `audit_log` has a permissive
 * RLS policy (migration 0007), so it is not defence-in-depth here. `payload ?
 * 'member_id'` lets the planner use the partial index `audit_log_member_id_idx`
 * (migration 0009).
 *
 * `memberIdText` is the member id as text: a bound value
 * (`sql\`${memberId}\``) or a column (`sql\`m.member_id::text\``).
 */
import { sql, type SQL } from 'drizzle-orm';

export function memberErasedRecordExists(tenantSlug: string, memberIdText: SQL): SQL {
  return sql`EXISTS (
          SELECT 1 FROM audit_log al_done
          WHERE al_done.tenant_id = ${tenantSlug}
            AND al_done.event_type = 'member_erased'
            AND al_done.payload ? 'member_id'
            AND al_done.payload->>'member_id' = ${memberIdText}
        )`;
}

/** A Postgres boolean read through `tx.execute`: a JS boolean or the text form. */
export function pgBool(v: unknown): boolean {
  return v === true || v === 't';
}
