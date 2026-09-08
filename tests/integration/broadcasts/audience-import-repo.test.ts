// @vitest-environment node
/**
 * T086 (108 US5) — the two repository writes that track a Contacts-Import job,
 * against live Neon.
 *
 * These are thin, which is exactly why they need a live test rather than a
 * stub: everything that can go wrong here lives in Postgres, not in TypeScript.
 *
 *   - `broadcasts_immutable_after_submit_fn` (migration 0224) locks the row
 *     after submit. Its non-GUC branch is a BLOCKLIST that does not name these
 *     columns, so the writes should pass — "should" is what this replaces.
 *   - `broadcasts_audience_import_coherent` (0298) forbids a completion stamp
 *     without a job id, and a submitted-at without one. Unreachable through the
 *     use case; the CHECK is what keeps a future writer honest, and a CHECK
 *     nobody has ever tripped is a CHECK nobody has verified.
 *   - `assertTenantBoundTx` + the rowcount assertion in each adapter method.
 *
 * The row stays `approved` throughout — there is no `audience_building` status
 * (see 0298: a new status would make the broadcast un-cancellable, the same
 * defect the 2026-09-08 reliability review raised against the batch drift halt).
 * That invariant is asserted here because the whole design rests on it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const CREATED: string[] = [];

async function seedApproved(): Promise<string> {
  const broadcastId = randomUUID();
  CREATED.push(broadcastId);
  await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
    await tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, status, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count,
        submitted_at, approved_at
      ) VALUES (
        ${TEST_TENANT}, ${broadcastId}::uuid, 'approved',
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'admin_proxy', 'T086 import host', '<p>x</p>', '<p>x</p>',
        'T086 Test', 'noreply@swecham.example', 'all_members', NULL,
        NULL, 3, now(), now()
      )
    `);
  });
  return broadcastId;
}

async function readImportCols(broadcastIdRaw: string): Promise<{
  audience_import_id: string | null;
  submitted: boolean;
  completed: boolean;
  status: string;
}> {
  const rows = (await runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
    tx.execute(sql`
      SELECT audience_import_id,
             audience_import_submitted_at IS NOT NULL AS submitted,
             audience_import_completed_at IS NOT NULL AS completed,
             status::text AS status
      FROM broadcasts
      WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${broadcastIdRaw}::uuid
    `),
  )) as unknown as Array<{
    audience_import_id: string | null;
    submitted: boolean;
    completed: boolean;
    status: string;
  }>;
  return rows[0]!;
}

/**
 * Drizzle wraps the driver error, so the message is only "Failed query: ...".
 * The constraint NAME and SQLSTATE live on the cause — assert those, or the
 * test passes for any failure at all, including a typo in the UPDATE.
 */
async function expectCheckViolation(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected the CHECK to reject this write').not.toBeNull();
  // `constraint_name`, NOT `constraint`: this repo's driver is postgres.js,
  // whose PostgresError uses snake_case field names (`node-pg` uses
  // `constraint`, which is what most examples show and what silently reads
  // `undefined` here — a test asserting on it passes for ANY failure).
  const cause = (thrown as { cause?: Record<string, unknown> }).cause;
  expect(cause?.['code']).toBe('23514');
  expect(cause?.['constraint_name']).toBe('broadcasts_audience_import_coherent');
}

describe.runIf(RUN_INTEGRATION)('T086 — audience-import repo writes (live Neon)', () => {
  afterAll(async () => {
    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      for (const id of CREATED) {
        await tx.execute(sql`
          DELETE FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
        `);
      }
    });
  });

  it('attach then complete: both writes land on an APPROVED row, and it stays approved', async () => {
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const tenantCtx = asTenantContext(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);

    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, tenantCtx.slug, broadcastId, 'imp_live_1');
    });

    let row = await readImportCols(raw);
    expect(row.audience_import_id).toBe('imp_live_1');
    expect(row.submitted).toBe(true);
    // Not complete yet — the import is in flight. Sending here would send to
    // whatever Resend has managed to ingest so far.
    expect(row.completed).toBe(false);
    expect(row.status).toBe('approved');

    await repo.withTx(async (tx) => {
      await repo.markAudienceImportCompleted(tx, tenantCtx.slug, broadcastId);
    });

    row = await readImportCols(raw);
    expect(row.completed).toBe(true);
    // The row is STILL approved and therefore still cancellable. The whole
    // reason there is no `audience_building` status.
    expect(row.status).toBe('approved');
  }, 30_000);

  it('the coherence CHECK rejects a completion stamp with no import id', async () => {
    const raw = await seedApproved();
    await expectCheckViolation(() =>
      runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
        tx.execute(sql`
          UPDATE broadcasts SET audience_import_completed_at = now()
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid
        `),
      ),
    );
  }, 30_000);

  it('the coherence CHECK rejects a submitted-at with no import id', async () => {
    // The mirror case. Both directions matter: a half-written pair is how a
    // future writer would strand a broadcast with no job to poll.
    const raw = await seedApproved();
    await expectCheckViolation(() =>
      runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
        tx.execute(sql`
          UPDATE broadcasts SET audience_import_submitted_at = now()
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid
        `),
      ),
    );
  }, 30_000);

  it('attaching twice overwrites rather than erroring — a retried tick must be harmless', async () => {
    // `upsert` on the Resend side makes a resubmitted import safe; this is the
    // database half of the same property. The use case guards against a second
    // submit while an id is set, but if it ever does, the row must not 23514.
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);
    const slug = asTenantContext(TEST_TENANT).slug;

    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_first');
    });
    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_second');
    });

    expect((await readImportCols(raw)).audience_import_id).toBe('imp_second');
  }, 30_000);
});
