/**
 * E2E seed: creates a `partially_sent` broadcast with one `sent` +
 * one `failed` batch manifest so the
 * `tests/e2e/broadcasts/pagination-batch-breakdown.spec.ts` admin
 * detail view exercises the per-batch breakdown collapsible.
 *
 * Idempotent: deletes any prior seed row for the test tenant before
 * re-inserting (lookup via `subject = 'E2E partial broadcast seed'`).
 *
 * Usage:
 *   pnpm tsx scripts/seed-partial-broadcast.ts
 *   # → prints `E2E_PARTIAL_BROADCAST_ID=<uuid>` to stdout
 *   #   so the operator can `export E2E_PARTIAL_BROADCAST_ID=…` for
 *   #   the next `pnpm test:e2e` invocation.
 *
 * Authored 2026-05-21 to close the pagination-batch-breakdown E2E gap
 * (the spec header references `scripts/seed-partial-broadcast.ts`
 * which never landed in Phase 3 — this fills the gap).
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const TENANT_ID = 'swecham';
const SUBJECT = 'E2E partial broadcast seed';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const sql = postgres(dbUrl, { ssl: 'require', max: 2 });
  try {
    // Clean prior seed row(s) to keep this script idempotent.
    // ON DELETE CASCADE on broadcast_batch_manifests handles the
    // batch rows; broadcast_deliveries cascades likewise.
    await sql`
      DELETE FROM broadcasts
      WHERE tenant_id = ${TENANT_ID}
        AND subject = ${SUBJECT}
    `;

    // Resolve a real member + user id from the test tenant. The
    // partial broadcast must FK to actual rows; we cannot synthesise.
    const [memberRow] = await sql<
      { readonly member_id: string }[]
    >`
      SELECT member_id FROM members
      WHERE tenant_id = ${TENANT_ID} AND archived_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (!memberRow) {
      console.error(
        '[seed-partial-broadcast] no eligible member found in tenant ' +
          TENANT_ID +
          '. Seed F3 first.',
      );
      process.exit(1);
    }
    const memberId = memberRow.member_id;

    // `users` is cross-tenant in F1 — no tenant_id, no archived_at.
    // Just pick the oldest admin user (any will FK-satisfy submitted_by).
    const [userRow] = await sql<{ readonly id: string }[]>`
      SELECT id FROM users
      WHERE role = 'admin'
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (!userRow) {
      console.error('[seed-partial-broadcast] no admin user found.');
      process.exit(1);
    }
    const userId = userRow.id;

    // FK requires a real plan id snapshot — fetch one from membership_plans
    // (uses `deleted_at` not `archived_at`).
    const [planRow] = await sql<{ readonly plan_id: string }[]>`
      SELECT plan_id FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (!planRow) {
      console.error(
        '[seed-partial-broadcast] no plan found in tenant ' + TENANT_ID + '.',
      );
      process.exit(1);
    }
    const planId = planRow.plan_id;

    const broadcastId = randomUUID();
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Insert the broadcast in `partially_sent` state with
    // manual_retry_count=1 + estimated_recipient_count=15000 (>10k,
    // triggering the per-batch breakdown UI). 2 batches: one sent +
    // one failed.
    await sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, status,
        requested_by_member_id, requested_by_member_plan_id_snapshot,
        submitted_by_user_id, actor_role,
        subject, body_html, body_source, from_name, reply_to_email,
        segment_type, segment_params, custom_recipient_emails,
        estimated_recipient_count,
        submitted_at, approved_at, approved_by_user_id,
        sending_started_at,
        manual_retry_count
      ) VALUES (
        ${TENANT_ID}, ${broadcastId}::uuid, 'partially_sent',
        ${memberId}::uuid, ${planId},
        ${userId}::uuid, 'admin_proxy',
        ${SUBJECT},
        '<p>Test partial broadcast body for E2E.</p>',
        '<p>Test partial broadcast body for E2E.</p>',
        'E2E Test', 'noreply@swecham.example',
        'all_members', NULL, NULL,
        15000,
        ${twoHoursAgo}::timestamptz,
        ${twoHoursAgo}::timestamptz,
        ${userId}::uuid,
        ${oneHourAgo}::timestamptz,
        1
      )
    `;

    // Batch 0 — succeeded (10,000 recipients).
    await sql`
      INSERT INTO broadcast_batch_manifests (
        tenant_id, broadcast_id, batch_index, recipient_count,
        recipient_range_start, recipient_range_end,
        status, provider_audience_id, idempotency_key,
        retry_count, delivered_count,
        dispatched_at
      ) VALUES (
        ${TENANT_ID}, ${broadcastId}::uuid, 0, 10000,
        0, 9999,
        'sent', ${'rsnd_audience_e2e_sent_' + randomUUID().slice(0, 8)},
        ${'broadcast-' + broadcastId + '-batch-0-attempt-0'},
        0, 9950,
        ${oneHourAgo}::timestamptz
      )
    `;

    // Batch 1 — failed (5,000 recipients) after 1 manual retry.
    await sql`
      INSERT INTO broadcast_batch_manifests (
        tenant_id, broadcast_id, batch_index, recipient_count,
        recipient_range_start, recipient_range_end,
        status, provider_audience_id, idempotency_key,
        retry_count,
        dispatched_at, failed_at, failure_reason
      ) VALUES (
        ${TENANT_ID}, ${broadcastId}::uuid, 1, 5000,
        10000, 14999,
        'failed', ${'rsnd_audience_e2e_failed_' + randomUUID().slice(0, 8)},
        ${'broadcast-' + broadcastId + '-batch-1-attempt-1'},
        1,
        ${oneHourAgo}::timestamptz, ${now}::timestamptz,
        'E2E seed: simulated Resend 5xx for partial-send scenario'
      )
    `;

    console.log(`E2E_PARTIAL_BROADCAST_ID=${broadcastId}`);
    console.log(
      `[seed-partial-broadcast] OK — tenant=${TENANT_ID} broadcast=${broadcastId} ` +
        `status=partially_sent batches=2 (sent + failed)`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
