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

  /**
   * 0299 (review S10). THIS CASE PASSED BEFORE 0299 AND IS THE PROOF OF THE BUG.
   *
   * 0298 wrote the coherence rule as three one-way implications, so
   * `(import_id set, submitted_at NULL)` satisfied all of them. That row was
   * fail-open in two independent places at once: the use case computed
   * `ageMs = 0` for it — never older than the 30-minute threshold, so it polled
   * for ever — and the stuck gauge could not see it either, because
   * `NULL < now() - interval '30 minutes'` is NULL, not true. A broadcast stuck
   * with no alarm and no automatic way out.
   */
  it('the coherence CHECK rejects an import id with no submitted-at (0299 iff)', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();

    await expectCheckViolation(() =>
      runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
        tx.execute(sql`
          UPDATE broadcasts SET audience_import_id = 'imp_orphan'
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`),
      ),
    );
  }, 30_000);

  it('the coherence CHECK rejects a completion that precedes its submit (0299)', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();

    await expectCheckViolation(() =>
      runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
        tx.execute(sql`
          UPDATE broadcasts
             SET audience_import_id = 'imp_backwards',
                 audience_import_submitted_at = now(),
                 audience_import_completed_at = now() - interval '1 hour'
           WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`),
      ),
    );
  }, 30_000);

  /**
   * POSITIVE CONTROL for the two cases above. Without it they pass just as
   * happily if the CHECK were tightened into rejecting EVERY write to these
   * columns — which would break the two-tick build while both negative
   * assertions still went green.
   */
  it('POSITIVE CONTROL — the legal shapes are still accepted after 0299', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();

    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      // id + submitted together (what tick 1 writes)
      await tx.execute(sql`
        UPDATE broadcasts
           SET audience_import_id = 'imp_ok', audience_import_submitted_at = now()
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`);
      // then a completion at or after it (what tick 2 writes)
      await tx.execute(sql`
        UPDATE broadcasts SET audience_import_completed_at = now()
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`);
    });

    // `readImportCols` projects the two timestamps as BOOLEANS (`submitted` /
    // `completed`), not as raw columns. The first draft of this case asserted
    // `cols.audience_import_submitted_at).not.toBeNull()` — which reads
    // `undefined`, and `expect(undefined).not.toBeNull()` PASSES. Two of the
    // three assertions here were vacuous, in a test written to close a vacuous
    // assertion. Caught only because the sibling cross-tenant case used
    // `toBeNull()` in the same wrong way and failed loudly.
    const cols = await readImportCols(raw);
    expect(cols.audience_import_id).toBe('imp_ok');
    expect(cols.submitted).toBe(true);
    expect(cols.completed).toBe(true);
  }, 30_000);

  /**
   * Constitution v1.4.2 Principle I clause 3 — the mandatory cross-tenant
   * integration test for a new tenant-scoped write surface. A Review-gate
   * blocker regardless of blast radius (precedent: 088 T065b), and this branch
   * added three such writes plus a whole use case without one.
   *
   * Two layers, asserted separately, because they fail for different reasons and
   * the docstring on `assertTenantBoundTx` is explicit that it is a cooperative
   * guard rather than a security boundary:
   *
   *   1. APPLICATION — the adapter, handed a tx bound to tenant A and asked to
   *      write tenant B's row, must throw before issuing anything.
   *   2. DATABASE — a raw UPDATE inside `runInTenant(B)` against A's row must
   *      affect ZERO rows, because RLS+FORCE filters it. This is the layer that
   *      still holds if someone deletes the helper.
   */
  it('cross-tenant: neither the adapter nor RLS lets tenant B touch tenant A row', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved(); // owned by TEST_TENANT
    const OTHER = 'e2e-tenant';
    const repo = makeDrizzleBroadcastsRepo(OTHER);
    const broadcastId = asBroadcastId(raw);

    // Layer 1 — the application guard refuses a tenant-mismatched tx.
    const otherSlug = asTenantContext(OTHER).slug;
    await expect(
      runInTenant(asTenantContext(OTHER), async (tx) =>
        repo.attachAudienceImport(tx, otherSlug, broadcastId, 'imp_evil'),
      ),
    ).rejects.toThrow();

    // Layer 2 — and RLS refuses the raw statement even with the guard bypassed.
    // `UPDATE ... RETURNING` returns nothing when the row is invisible, which is
    // the fail-closed answer we want rather than an error.
    const affected = await runInTenant(asTenantContext(OTHER), async (tx) =>
      tx.execute(sql`
        UPDATE broadcasts
           SET audience_import_id = 'imp_evil', audience_import_submitted_at = now()
         WHERE broadcast_id = ${raw}::uuid
        RETURNING broadcast_id`),
    );
    expect((affected as unknown as unknown[]).length).toBe(0);

    // And A's row is untouched — the assertion that makes the two above mean
    // something. A guard that throws AFTER writing would pass both of them.
    const cols = await readImportCols(raw);
    expect(cols.audience_import_id).toBeNull();
    expect(cols.submitted).toBe(false);
    expect(cols.completed).toBe(false);
  }, 30_000);
});
