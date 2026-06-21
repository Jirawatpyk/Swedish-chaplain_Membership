/**
 * E2E seed helper for F7 broadcasts (US2 admin review queue).
 *
 * Provisions:
 *   1. A `submitted` broadcast row owned by the existing `e2e-member`
 *      account → returned `broadcastId` consumed by AS2-AS6 tests as
 *      the row to approve / reject / cancel.
 *   2. A halted member (existing seed account flipped) →
 *      `broadcasts_halted_until_admin_review = true` → consumed by Q14.
 *
 * Idempotent: callers re-seed at the start of every E2E run. A prior
 * run's broadcast row is left in place (audit-log immutability) but
 * its status is flipped back to `submitted` so admin actions in the
 * new run start from a known state.
 *
 * Direct DB access via `postgres` (no Drizzle) — the schema layer here
 * is a thin INSERT to keep the seed independent of any future schema
 * refactor. tenant_id matches whatever `E2E_X_TENANT` resolves to
 * (`swecham` for the shared e2e tenant).
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';

interface SeedResult {
  readonly broadcastId: string;
  readonly haltedMemberDisplayName: string;
}

export async function seedF7Broadcasts(): Promise<SeedResult | null> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!dbUrl || !memberEmail) {
    console.warn(
      '[e2e seed broadcasts] skipped — DATABASE_URL or E2E_MEMBER_EMAIL missing',
    );
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // Resolve member + plan from existing e2e-member seed
    const memberRows = await sql<
      Array<{
        user_id: string;
        member_id: string;
        plan_uuid: string;
        primary_contact_email: string;
        company_name: string;
      }>
    >`
      SELECT u.id::text AS user_id,
             m.member_id::text AS member_id,
             m.plan_id AS plan_uuid,
             COALESCE(pc.email, u.email) AS primary_contact_email,
             m.company_name
      FROM users u
      JOIN contacts c
        ON c.linked_user_id = u.id AND c.tenant_id = ${TENANT_ID}
      JOIN members m
        ON m.member_id = c.member_id AND m.tenant_id = ${TENANT_ID}
      LEFT JOIN contacts pc
        ON pc.member_id = m.member_id
       AND pc.tenant_id = ${TENANT_ID}
       AND pc.is_primary = TRUE
       AND pc.removed_at IS NULL
      WHERE u.email = ${memberEmail}
      LIMIT 1
    `;
    const member = memberRows[0];
    if (!member) {
      console.warn(
        `[e2e seed broadcasts] e2e-member not found in tenant ${TENANT_ID}; skipping seed`,
      );
      return null;
    }

    // Reuse a stable broadcast id keyed by member so the seed is idempotent
    const broadcastIdRows = await sql<Array<{ broadcast_id: string }>>`
      SELECT broadcast_id::text AS broadcast_id
      FROM broadcasts
      WHERE tenant_id = ${TENANT_ID}
        AND requested_by_member_id = ${member.member_id}::uuid
        AND subject = '[E2E SEED] AS2-AS6 fixture broadcast'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const existingId = broadcastIdRows[0]?.broadcast_id;
    let broadcastId: string;
    if (existingId) {
      // The immutability trigger blocks UPDATE of scheduled_for after
      // status leaves 'draft'. DELETE + re-INSERT bypasses the trigger
      // and gives us a clean `submitted` row for the next destructive
      // test. The audit-log entries from the previous run are retained
      // (append-only per Constitution Principle I).
      await sql`
        DELETE FROM broadcast_deliveries
        WHERE tenant_id = ${TENANT_ID}
          AND broadcast_id = ${existingId}::uuid
      `;
      await sql`
        DELETE FROM broadcasts
        WHERE tenant_id = ${TENANT_ID}
          AND broadcast_id = ${existingId}::uuid
      `;
      broadcastId = existingId;
      await sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id,
          requested_by_member_id, requested_by_member_plan_id_snapshot,
          submitted_by_user_id, actor_role,
          subject, body_html, body_source,
          from_name, reply_to_email,
          segment_type, segment_params, custom_recipient_emails,
          estimated_recipient_count,
          status, submitted_at,
          retention_years, created_at, updated_at
        ) VALUES (
          ${TENANT_ID}, ${broadcastId}::uuid,
          ${member.member_id}::uuid, ${member.plan_uuid},
          ${member.user_id}::uuid, 'member_self_service',
          '[E2E SEED] AS2-AS6 fixture broadcast',
          '<p>This is a test broadcast seeded for the admin review queue E2E suite.</p>',
          'plain',
          'SweCham', ${member.primary_contact_email},
          'all_members', NULL, NULL,
          1,
          'submitted', NOW(),
          5, NOW(), NOW()
        )
      `;
    } else {
      const newId = randomUUID();
      await sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id,
          requested_by_member_id, requested_by_member_plan_id_snapshot,
          submitted_by_user_id, actor_role,
          subject, body_html, body_source,
          from_name, reply_to_email,
          segment_type, segment_params, custom_recipient_emails,
          estimated_recipient_count,
          status, submitted_at,
          retention_years, created_at, updated_at
        ) VALUES (
          ${TENANT_ID}, ${newId}::uuid,
          ${member.member_id}::uuid, ${member.plan_uuid},
          ${member.user_id}::uuid, 'member_self_service',
          '[E2E SEED] AS2-AS6 fixture broadcast',
          '<p>This is a test broadcast seeded for the admin review queue E2E suite.</p>',
          'plain',
          'SweCham', ${member.primary_contact_email},
          'all_members', NULL, NULL,
          1,
          'submitted', NOW(),
          5, NOW(), NOW()
        )
      `;
      broadcastId = newId;
    }

    // Pick a halted-member fixture: flip the halt flag on a different
    // member than e2e-member (so AS5 manager-readonly + AS1 queue stay
    // unaffected). Use the first member in tenant whose name starts with
    // "[HALT" — or create one by flipping any non-e2e member.
    const haltCandidate = await sql<
      Array<{ member_id: string; company_name: string }>
    >`
      SELECT member_id::text AS member_id, company_name
      FROM members
      WHERE tenant_id = ${TENANT_ID}
        AND member_id != ${member.member_id}::uuid
      ORDER BY created_at ASC
      LIMIT 1
    `;
    let haltedDisplayName = '';
    const halted = haltCandidate[0];
    if (halted) {
      await sql`
        UPDATE members
        SET broadcasts_halted_until_admin_review = TRUE,
            updated_at = NOW()
        WHERE tenant_id = ${TENANT_ID}
          AND member_id = ${halted.member_id}::uuid
      `;
      haltedDisplayName = halted.company_name;
    }

    console.log(
      `[e2e seed broadcasts] OK broadcast=${broadcastId} halted="${haltedDisplayName}"`,
    );
    return { broadcastId, haltedMemberDisplayName: haltedDisplayName };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Best-effort cleanup — flips the halted member back to non-halted so
 * subsequent test runs against the shared tenant don't pile up halts.
 * Safe to call after a fully-skipped run (no-op).
 */
export async function clearF7HaltSeed(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    await sql`
      UPDATE members
      SET broadcasts_halted_until_admin_review = FALSE,
          updated_at = NOW()
      WHERE tenant_id = ${TENANT_ID}
        AND broadcasts_halted_until_admin_review = TRUE
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * F7 US3 AS2 seed — append a `member_plan_changed` audit row for the
 * e2e-member, dated 90 days before now (well inside the current
 * Bangkok-tz quota year for any reasonable test execution date).
 *
 * `audit_log` is append-only (migration 0001 trigger), so re-runs add
 * a new row each time — the page's most-recent-row query
 * (`ORDER BY "timestamp" DESC LIMIT 1`) always picks up the latest
 * seed, keeping the assertion deterministic.
 *
 * Returns the inserted audit row id + the changed-at timestamp the
 * caller asserts on. No cleanup function — the audit trail is part
 * of the project's compliance evidence and rows accumulate harmlessly.
 */
export async function seedF7PlanChangedAudit(): Promise<{
  readonly auditId: string;
  readonly changedAt: Date;
} | null> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!dbUrl || !memberEmail) {
    console.warn(
      '[e2e seed broadcasts] seedF7PlanChangedAudit skipped — DATABASE_URL or E2E_MEMBER_EMAIL missing',
    );
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const memberRows = await sql<Array<{ member_id: string }>>`
      SELECT m.member_id::text AS member_id
      FROM members m
      JOIN contacts c ON c.member_id = m.member_id
      JOIN users u ON u.id = c.linked_user_id
      WHERE m.tenant_id = ${TENANT_ID} AND LOWER(u.email) = LOWER(${memberEmail})
      LIMIT 1
    `;
    const member = memberRows[0];
    if (!member) {
      console.warn(
        `[e2e seed broadcasts] seedF7PlanChangedAudit — e2e-member not found in tenant ${TENANT_ID}; skipping seed`,
      );
      return null;
    }

    const changedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO audit_log (
        event_type, actor_user_id, summary, request_id, tenant_id,
        payload, "timestamp"
      )
      VALUES (
        'member_plan_changed',
        'system:e2e-seed',
        ${'E2E seed — plan changed for ' + member.member_id},
        ${'e2e-seed-' + Date.now()},
        ${TENANT_ID},
        ${sql.json({ member_id: member.member_id, old_plan_id: 'regular_corporate', new_plan_id: 'premium_corporate' })},
        ${changedAt.toISOString()}
      )
      RETURNING id::text AS id
    `;
    const row = inserted[0];
    if (!row) {
      console.warn(
        '[e2e seed broadcasts] seedF7PlanChangedAudit — INSERT returned no rows; skipping',
      );
      return null;
    }
    console.log(
      `[e2e seed broadcasts] OK member_plan_changed audit=${row.id} member=${member.member_id} changedAt=${changedAt.toISOString()}`,
    );
    return { auditId: row.id, changedAt };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * F7 US3 AS6/AS7 reset — clears `members.broadcasts_acknowledged_at`
 * for the e2e-member so the Q15 banner re-renders on the next portal
 * navigation. Used by AS6 (assert banner present) + AS7 (assert
 * acknowledge → dismiss + audit) to prevent state pollution across
 * browser projects (chromium → mobile-safari → mobile-chrome) where
 * a successful AS7 in one project would leave the column set and
 * subsequent project AS6 + AS7 runs would see no banner.
 *
 * Returns true if the column was reset; false if env vars missing
 * (caller falls back to skipping the test).
 */
export async function resetF7AckSeed(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  if (!dbUrl || !memberEmail) {
    // Fail loud — silent no-op would surface later as a confusing
    // AS6/AS7 "banner not present" failure that's actually a CI
    // misconfiguration. Per the project memory `feedback_skip_is_not_pass`,
    // env-missing in a seed helper is a CI bug, not a test signal.
    throw new Error(
      'resetF7AckSeed: DATABASE_URL or E2E_MEMBER_EMAIL missing — refusing to no-op (would mask AS6/AS7 banner state).',
    );
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    // Inner JOIN explicitly scopes contacts to the same tenant as the
    // outer member row — defensive consistency with `seedF7Broadcasts`
    // pattern (member_id is UUID-unique today, but multi-tenant
    // schema treats `(tenant_id, member_id)` as the canonical PK).
    await sql`
      UPDATE members
      SET broadcasts_acknowledged_at = NULL,
          updated_at = NOW()
      WHERE tenant_id = ${TENANT_ID}
        AND member_id IN (
          SELECT m.member_id
          FROM members m
          JOIN contacts c
            ON c.member_id = m.member_id
           AND c.tenant_id = m.tenant_id
           AND c.tenant_id = ${TENANT_ID}
          JOIN users u ON u.id = c.linked_user_id
          WHERE LOWER(u.email) = LOWER(${memberEmail})
        )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Verify-fix R4 (Simplify-#1, 2026-05-02) — extracted from
 * `tests/e2e/scheduled-send-cron.spec.ts` + `broadcast-cancel-too-late.spec.ts`
 * (was duplicated byte-identical across both).
 *
 * Resets e2e-member's broadcast history so the test starts with a
 * fresh 1/1 quota slot. `failed_to_dispatch` now RELEASES the quota
 * slot (Design D1, 2026-06-21), but `submitted`/`approved` rows still
 * hold a slot in F7's enforcement count while in-flight — a single
 * failed CI run could leave those behind and pollute subsequent runs.
 * This helper wipes ALL broadcasts owned by e2e-member regardless of
 * status (BYPASSRLS via raw `postgres`).
 *
 * Audit rows are append-only and survive — the wipe only touches
 * `broadcasts` + `broadcast_deliveries` (FK cascade via temporary
 * trigger disable, mirrors `tests/integration/helpers/test-tenant.ts`).
 *
 * Skips silently if `DATABASE_URL` is missing.
 */
export async function wipeE2EMemberBroadcasts(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  const tenantId = process.env.E2E_TENANT_SLUG ?? 'swecham';
  if (!dbUrl || !memberEmail) return;
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const memberRows = await sql<Array<{ member_id: string }>>`
      SELECT m.member_id::text AS member_id
      FROM users u
      JOIN contacts c
        ON c.linked_user_id = u.id AND c.tenant_id = ${tenantId}
      JOIN members m
        ON m.member_id = c.member_id AND m.tenant_id = ${tenantId}
      WHERE u.email = ${memberEmail}
      LIMIT 1
    `;
    const memberId = memberRows[0]?.member_id;
    if (!memberId) return;
    await sql`
      ALTER TABLE broadcast_deliveries DISABLE TRIGGER broadcast_deliveries_no_delete
    `;
    await sql`
      DELETE FROM broadcast_deliveries
      WHERE broadcast_id IN (
        SELECT broadcast_id FROM broadcasts
        WHERE requested_by_member_id = ${memberId}::uuid
      )
    `;
    await sql`
      ALTER TABLE broadcast_deliveries ENABLE TRIGGER broadcast_deliveries_no_delete
    `;
    await sql`
      DELETE FROM broadcasts
      WHERE requested_by_member_id = ${memberId}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
