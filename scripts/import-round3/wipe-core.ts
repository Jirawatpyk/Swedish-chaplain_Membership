/**
 * Round-3 wipe — executable core (Part 3 of the Round-3 import;
 * docs/import/ROUND3_PLAN.md § Wipe). Deletion ORDER + protected-table
 * inventory live in ./wipe-plan.ts (pure, unit-tested); this module owns
 * the SQL. Operator CLI: scripts/wipe-tenant-business-data.ts. Integration
 * proof: tests/integration/scripts/wipe-tenant-business-data.test.ts.
 *
 * WHY THE OWNER-ROLE `db` SINGLETON + EXPLICIT tenant_id PREDICATES
 * (mirrors scripts/clear-test-data.ts): the wipe must see and delete rows
 * across RLS+FORCE tables without a tenant GUC. The `db` singleton connects
 * as Neon's `neondb_owner` (`rolbypassrls = TRUE` — see migration
 * 0006:97-104), so RLS is bypassed and EVERY statement therefore carries an
 * explicit `tenant_id = $1` predicate as the only scoping. A NON-bypassing
 * role would make every DELETE silently match 0 rows while printing a
 * successful report — catastrophic for a prod wipe — so `wipeTenantBusinessData`
 * hard-refuses to run unless `pg_roles.rolbypassrls` (or superuser) is true
 * for `current_user`.
 *
 * SAFETY MODEL
 *   - Dry-run (default): SELECT counts per step, ZERO writes.
 *   - `--commit`: additionally requires env `CONFIRM_WIPE=<tenantId>` EXACTLY
 *     (wipe-plan.assertCommitConfirmed), and runs every delete inside ONE
 *     transaction — an FK surprise mid-run rolls the whole wipe back.
 *   - Idempotent: a re-run counts/deletes 0 everywhere (the member-sequence
 *     reset only touches rows where last_number <> 0).
 *   - NEVER touched: see wipe-plan.PROTECTED_TABLES (audit_log append-only
 *     per Principle VIII; processor_events RLS-forbidden; admin users +
 *     system actors; plans; tenant_* config; broadcasts; F6 events).
 *
 * MEMBER-PORTAL USER RESOLUTION (read-before-scrub — ids resolved from
 * contacts BEFORE contacts are deleted):
 *   arm 1 — users referenced by contacts.linked_user_id in THIS tenant
 *           (accepted invitations);
 *   arm 2 — role='member' users whose email matches a contact email in THIS
 *           tenant (pending invitees — linked_user_id is only set on
 *           acceptance, so arm 1 alone would strand their PII-bearing rows).
 *   Exclusions (both arms): system actors (id '00000000-%'), role='admin',
 *   and any user linked from ANOTHER tenant's contact (cross-tenant users
 *   model — deleting a peer tenant's portal account is never acceptable).
 *   Their sessions / password_reset_tokens / invitee invitations are deleted
 *   explicitly; admin-issued invitations to ADMIN users are untouched.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { TENANT_SLUG_PATTERN } from '@/modules/tenants';
import {
  REFUND_CREDIT_NOTE_UNLINK_STEP,
  TENANT_TABLES_AFTER_USERS,
  TENANT_TABLES_BEFORE_USERS,
  assertCommitConfirmed,
} from './wipe-plan';

// Helper: normalize db.execute result across postgres-js drivers that
// may return either an array directly or `{ rows: [...] }` — mirrors
// scripts/clear-test-data.ts.
function unwrap<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** Anything with drizzle's `.execute` — satisfied by both `db` and a tx. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

export interface WipeStepCount {
  /** Step name — a table name from wipe-plan.WIPE_STEP_ORDER. */
  readonly table: string;
  /** Dry-run: rows that WOULD be affected. Commit: rows actually affected. */
  readonly rows: number;
}

export interface WipeReport {
  readonly tenantId: string;
  readonly mode: 'dry-run' | 'commit';
  /** Per-step counts in execution order (PII-free: table names + counts only). */
  readonly counts: readonly WipeStepCount[];
  /** How many member-portal user accounts were targeted (count only). */
  readonly memberPortalUsers: number;
}

const tenantCount = async (
  exec: SqlExecutor,
  table: string,
  tenantId: string,
): Promise<number> => {
  // `table` comes ONLY from the wipe-plan const arrays (never operator input),
  // so sql.raw interpolation is safe here.
  const r = await exec.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE tenant_id = ${tenantId}`,
  );
  return unwrap<{ n: number }>(r)[0]?.n ?? 0;
};

const tenantDelete = async (
  exec: SqlExecutor,
  table: string,
  tenantId: string,
): Promise<number> => {
  const r = await exec.execute(
    sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id = ${tenantId} RETURNING 1`,
  );
  return unwrap(r).length;
};

/** Resolve the member-portal user ids for this tenant (see file docstring). */
async function resolveMemberPortalUserIds(
  exec: SqlExecutor,
  tenantId: string,
): Promise<string[]> {
  const r = await exec.execute(sql`
    SELECT u.id::text AS id
    FROM users u
    WHERE u.role <> 'admin'
      AND u.id::text NOT LIKE '00000000-%'
      AND NOT EXISTS (
        SELECT 1 FROM contacts peer
        WHERE peer.linked_user_id = u.id AND peer.tenant_id <> ${tenantId}
      )
      AND (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.linked_user_id = u.id AND c.tenant_id = ${tenantId}
        )
        OR (
          u.role = 'member'
          AND EXISTS (
            SELECT 1 FROM contacts c2
            WHERE c2.tenant_id = ${tenantId}
              AND lower(c2.email) = lower(u.email)
          )
        )
      )
  `);
  return unwrap<{ id: string }>(r).map((row) => row.id);
}

/**
 * `id IN (uuid, uuid, …)` list from the ONCE-resolved member-user set —
 * the proven clear-test-data.ts pattern (a bare JS array inside a drizzle
 * sql template expands to a `($1, $2)` TUPLE, which cannot cast to uuid[],
 * so `= ANY(${ids}::uuid[])` is not expressible here).
 */
const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** [table, WHERE fragment factory] for the member-user child steps. */
const userStepPredicates: ReadonlyArray<
  readonly [string, (ids: readonly string[]) => SQL]
> = [
  ['sessions', (ids) => sql`user_id IN (${uuidList(ids)})`],
  ['password_reset_tokens', (ids) => sql`user_id IN (${uuidList(ids)})`],
  // Invitee rows only — `invited_by_user_id` (admin audit trail) is never a
  // delete key here. Admin invitations (invitee is an admin user) are not in
  // the id set, so they survive.
  ['invitations', (ids) => sql`user_id IN (${uuidList(ids)})`],
  [
    'users',
    // Defensive re-assertion of the exclusions even though the resolved set
    // already honours them.
    (ids) =>
      sql`id IN (${uuidList(ids)}) AND role <> 'admin' AND id::text NOT LIKE '00000000-%'`,
  ],
];

async function runSteps(
  exec: SqlExecutor,
  tenantId: string,
  mode: 'dry-run' | 'commit',
): Promise<{ counts: WipeStepCount[]; memberPortalUsers: number }> {
  const counts: WipeStepCount[] = [];

  // Read-before-scrub: resolve the member-user set while contacts still exist.
  const memberUserIds = await resolveMemberPortalUserIds(exec, tenantId);

  // FK-cycle breaker (wipe-plan header § 2): refunds ↔ credit_notes are
  // MUTUALLY ON DELETE RESTRICT (0034 refunds.credit_note_id → credit_notes;
  // 0038 credit_notes.source_refund_id → refunds), so no pure delete order
  // can succeed once a refund-origin credit note exists. Null the ONE edge
  // that is legally writable: refunds.credit_note_id.
  //
  // The bare NULL would violate the 0268 `refunds_succeeded_iff_documented`
  // CHECK on a succeeded refund ("succeeded ⟺ processor id AND (credit note
  // OR waiver)"), so the same UPDATE stamps the waiver columns — a TRANSIENT
  // state that satisfies every refunds CHECK (verified against 0034 + 0268)
  // and never escapes: the rows are deleted two steps later in the SAME tx
  // (dry-run performs a SELECT count only — zero writes). The other edge
  // (credit_notes.source_refund_id) is NOT an option: the 0227/0273
  // redaction-lock trigger raises on any change to it, on every write path.
  const unlinkWhere = sql`tenant_id = ${tenantId} AND credit_note_id IS NOT NULL`;
  const unlinkResult =
    mode === 'commit'
      ? await exec.execute(
          sql`UPDATE refunds
              SET credit_note_id = NULL,
                  credit_note_waived_at = COALESCE(credit_note_waived_at, now()),
                  credit_note_waiver_reason = COALESCE(credit_note_waiver_reason, 'invoice_voided'),
                  updated_at = now()
              WHERE ${unlinkWhere} RETURNING 1`,
        )
      : await exec.execute(
          sql`SELECT count(*)::int AS n FROM refunds WHERE ${unlinkWhere}`,
        );
  counts.push({
    table: REFUND_CREDIT_NOTE_UNLINK_STEP,
    rows:
      mode === 'commit'
        ? unwrap(unlinkResult).length
        : unwrap<{ n: number }>(unlinkResult)[0]?.n ?? 0,
  });

  for (const table of TENANT_TABLES_BEFORE_USERS) {
    const rows =
      mode === 'commit'
        ? await tenantDelete(exec, table, tenantId)
        : await tenantCount(exec, table, tenantId);
    counts.push({ table, rows });
  }

  for (const [table, wherePredicate] of userStepPredicates) {
    if (memberUserIds.length === 0) {
      counts.push({ table, rows: 0 });
      continue;
    }
    const where = wherePredicate(memberUserIds);
    const r =
      mode === 'commit'
        ? await exec.execute(
            sql`DELETE FROM ${sql.raw(table)} WHERE ${where} RETURNING 1`,
          )
        : await exec.execute(
            sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${where}`,
          );
    const rows =
      mode === 'commit' ? unwrap(r).length : unwrap<{ n: number }>(r)[0]?.n ?? 0;
    counts.push({ table, rows });
  }

  for (const table of TENANT_TABLES_AFTER_USERS) {
    const rows =
      mode === 'commit'
        ? await tenantDelete(exec, table, tenantId)
        : await tenantCount(exec, table, tenantId);
    counts.push({ table, rows });
  }

  // Numbering resets — LAST (see wipe-plan header). Document sequences are
  // DELETED (the allocator self-bootstraps at 1 via INSERT..ON CONFLICT — do
  // NOT pre-seed rows); the member-number counter row is KEPT and zeroed
  // (as is the SCCM prefix row in tenant_member_settings, untouched).
  counts.push({
    table: 'tenant_document_sequences',
    rows:
      mode === 'commit'
        ? await tenantDelete(exec, 'tenant_document_sequences', tenantId)
        : await tenantCount(exec, 'tenant_document_sequences', tenantId),
  });

  const memberSeqWhere = sql`tenant_id = ${tenantId} AND last_number <> 0`;
  const seqResult =
    mode === 'commit'
      ? await exec.execute(
          sql`UPDATE tenant_member_sequences
              SET last_number = 0, updated_at = now()
              WHERE ${memberSeqWhere} RETURNING 1`,
        )
      : await exec.execute(
          sql`SELECT count(*)::int AS n FROM tenant_member_sequences WHERE ${memberSeqWhere}`,
        );
  counts.push({
    table: 'tenant_member_sequences',
    rows:
      mode === 'commit'
        ? unwrap(seqResult).length
        : unwrap<{ n: number }>(seqResult)[0]?.n ?? 0,
  });

  return { counts, memberPortalUsers: memberUserIds.length };
}

/**
 * Wipe ALL business data for one tenant (dry-run by default).
 *
 * @param tenantId  target tenant slug (validated against TENANT_SLUG_PATTERN)
 * @param opts.commit  false → counts only, ZERO writes; true → delete inside
 *                     one transaction (requires env CONFIRM_WIPE=<tenantId>)
 */
export async function wipeTenantBusinessData(
  tenantId: string,
  opts: { readonly commit: boolean },
): Promise<WipeReport> {
  if (!TENANT_SLUG_PATTERN.test(tenantId)) {
    throw new Error(
      `wipeTenantBusinessData: refusing malformed tenant id ${JSON.stringify(tenantId)} ` +
        `(must match ${String(TENANT_SLUG_PATTERN)}).`,
    );
  }
  if (opts.commit) {
    assertCommitConfirmed(tenantId, process.env.CONFIRM_WIPE);
  }

  // Silent-0 guard: under a non-BYPASSRLS role every tenant-predicate DELETE
  // matches nothing (RLS+FORCE with no GUC) and the report would lie.
  const roleRow = await db.execute(
    sql`SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`,
  );
  if (unwrap<{ ok: boolean }>(roleRow)[0]?.ok !== true) {
    throw new Error(
      'wipeTenantBusinessData: current DB role does not bypass RLS — every ' +
        'DELETE would silently match 0 rows. Run with the owner-role ' +
        'DATABASE_URL (neondb_owner), not chamber_app.',
    );
  }

  if (!opts.commit) {
    const { counts, memberPortalUsers } = await runSteps(db, tenantId, 'dry-run');
    return { tenantId, mode: 'dry-run', counts, memberPortalUsers };
  }

  // One transaction — an FK surprise anywhere rolls back the ENTIRE wipe.
  const { counts, memberPortalUsers } = await db.transaction((tx) =>
    runSteps(tx, tenantId, 'commit'),
  );
  return { tenantId, mode: 'commit', counts, memberPortalUsers };
}

/** PII-free operator rendering (table names + counts only). */
export function renderWipeReportText(report: WipeReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`=== wipe-tenant-business-data (${report.mode}) ===`);
  lines.push(`Tenant: ${report.tenantId}`);
  lines.push(
    report.mode === 'dry-run'
      ? 'Mode:   DRY-RUN — counts only, ZERO writes'
      : 'Mode:   COMMIT — rows deleted inside one transaction',
  );
  lines.push(`Member-portal user accounts targeted: ${report.memberPortalUsers}`);
  lines.push('');
  const width = Math.max(...report.counts.map((c) => c.table.length));
  for (const c of report.counts) {
    const verb =
      c.table === 'tenant_member_sequences'
        ? report.mode === 'commit'
          ? 'reset-to-0'
          : 'would reset'
        : c.table === REFUND_CREDIT_NOTE_UNLINK_STEP
          ? report.mode === 'commit'
            ? 'unlinked'
            : 'would unlink'
          : report.mode === 'commit'
            ? 'deleted'
            : 'would delete';
    lines.push(`  ${c.table.padEnd(width)}  ${verb}  ${c.rows}`);
  }
  lines.push('');
  lines.push('  audit_log / processor_events: untouched (append-only by design)');
  lines.push('  membership_plans + tenant_* config + broadcasts + events: untouched');
  return lines.join('\n');
}
