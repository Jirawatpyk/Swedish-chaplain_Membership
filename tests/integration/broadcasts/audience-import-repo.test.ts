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
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';

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

  /**
   * Round 4 F9 — the `isNull(audienceImportCompletedAt)` precondition IS the fix
   * for round-3 3-9, and nothing fired it. `grep -rn markAudienceImportCompleted
   * tests/` returned 19 hits, 18 of them empty stubs, and the one real call was
   * on an unstamped row — the branch that existed before the precondition.
   *
   * Three branches hang off the 0-row probe. Two are exercised here; the third
   * ("row exists, not stamped, yet 0 rows updated" -> ConcurrentMutation) is
   * unreachable from a single connection, since the predicate that matched the
   * probe would have matched the UPDATE, so it is left to the type system rather
   * than faked.
   */
  it('F9 — re-stamping an ALREADY-completed import is silent, not an error', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const tenantCtx = asTenantContext(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);

    await runInTenant(tenantCtx, async (tx) => {
      await repo.attachAudienceImport(tx, tenantCtx.slug, broadcastId, 'imp-f9-once');
      await repo.markAudienceImportCompleted(tx, tenantCtx.slug, broadcastId);
    });
    const readStamp = async (): Promise<string> => {
      const rows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT audience_import_completed_at::text AS ts
          FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`),
      )) as unknown as Array<{ ts: string }>;
      return rows[0]!.ts;
    };
    const before = await readStamp();
    expect(before).not.toBeNull();

    // A retried tick must not throw — and, load-bearingly, must not MOVE the
    // stamp. A first draft of this case asserted only `completed === true`, which
    // an `isNull`-less UPDATE also satisfies: it re-stamps `now()` and the boolean
    // stays true. That version would have passed with the precondition deleted,
    // i.e. it tested nothing that 3-9 was about. The stamp answers "when was this
    // import consumed", so the assertion has to be the VALUE.
    await runInTenant(tenantCtx, async (tx) => {
      await repo.markAudienceImportCompleted(tx, tenantCtx.slug, broadcastId);
    });
    const after = await readStamp();
    expect(after).toBe(before);
  }, 30_000);

  it('F9 — stamping a broadcast that does not exist is BroadcastNotFoundError, not a silent no-op', async () => {
    if (!RUN_INTEGRATION) return;
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const tenantCtx = asTenantContext(TEST_TENANT);
    // A well-formed uuid that was never seeded: the probe finds nothing, which is
    // a real fault and must be named rather than swallowed as "already stamped".
    const ghost = asBroadcastId('00000000-0000-4000-8000-000000000f9a');

    await expect(
      runInTenant(tenantCtx, async (tx) =>
        repo.markAudienceImportCompleted(tx, tenantCtx.slug, ghost),
      ),
    ).rejects.toThrow(/not found/i);
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

  /**
   * S13 — compare-and-set, replacing a blind overwrite.
   *
   * `lockForUpdate` takes `pg_advisory_xact_lock`, but its tx COMMITS before any
   * gateway call, so the read of "is an import attached?" and the write that
   * attaches one live in different transactions and the lock protects neither.
   * Two overlapping ticks are reachable — `maxDuration` equals the cron cadence
   * — and both would attach, leaving `(resend_audience_id, audience_import_id)`
   * sourced from different ticks. That logically bypasses the `count_mismatch`
   * backstop: the counts get validated for one audience while the send goes to
   * the other.
   *
   * The precondition rides on the write itself rather than on a Postgres lock
   * held across a 300 s HTTP round trip.
   *
   * The old version of this case asserted that a second attach OVERWRITES,
   * justified as "a retried tick must be harmless". The behaviour it named is
   * preserved below (same id still succeeds); what it actually pinned was the
   * race.
   */
  it('re-attaching the SAME import id is idempotent — a retried tick is harmless', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);
    const slug = asTenantContext(TEST_TENANT).slug;

    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_first');
    });
    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_first');
    });

    expect((await readImportCols(raw)).audience_import_id).toBe('imp_first');
  }, 30_000);

  it('attaching a DIFFERENT import id over an existing one fails loudly', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);
    const slug = asTenantContext(TEST_TENANT).slug;

    await repo.withTx(async (tx) => {
      await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_first');
    });

    await expect(
      repo.withTx(async (tx) => {
        await repo.attachAudienceImport(tx, slug, broadcastId, 'imp_second');
      }),
    ).rejects.toThrow(BroadcastConcurrentMutationError);

    // And the first id survives — a losing writer must not have half-applied.
    expect((await readImportCols(raw)).audience_import_id).toBe('imp_first');
  }, 30_000);

  it('attaching a DIFFERENT audience id over an existing one fails loudly', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const broadcastId = asBroadcastId(raw);
    const slug = asTenantContext(TEST_TENANT).slug;

    await repo.withTx(async (tx) => {
      await repo.attachAudienceId(tx, slug, broadcastId, 'aud_first');
    });
    // Same id is still fine (the retried-tick case).
    await repo.withTx(async (tx) => {
      await repo.attachAudienceId(tx, slug, broadcastId, 'aud_first');
    });

    await expect(
      repo.withTx(async (tx) => {
        await repo.attachAudienceId(tx, slug, broadcastId, 'aud_second');
      }),
    ).rejects.toThrow(BroadcastConcurrentMutationError);
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
   * S11 / S46 — the stuck gauge must not LATCH.
   *
   * `failTerminally` resolves an incident by moving the row to
   * `failed_to_dispatch`. It deliberately does NOT clear `audience_import_id`
   * or stamp `completed_at` — those are forensic values, and an operator
   * investigating afterwards wants them. But the gauge's predicate had no
   * status filter, and `applyTransition`'s passthrough whitelist contains none
   * of the three import columns, so nothing in `src/` ever made such a row stop
   * matching: every terminal refusal and every cancel-after-submit incremented
   * `broadcasts_audience_import_stuck_count` permanently. An alarm that never
   * clears is worse than no alarm, because the NEXT incident is invisible
   * underneath it.
   *
   * Asserted here rather than in the contract test on purpose: that suite mocks
   * the SQL result rows, so it is structurally blind to the predicate. This runs
   * the real one against real rows.
   */
  it('the stuck-import gauge predicate ignores a row that already went terminal', async () => {
    if (!RUN_INTEGRATION) return;
    const stale = await seedApproved();
    const live = await seedApproved();

    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      // Both look "stuck" on the import columns alone: submitted 2 h ago, never
      // completed. The only difference is that one has been dealt with.
      for (const id of [stale, live]) {
        await tx.execute(sql`
          UPDATE broadcasts
             SET audience_import_id = 'imp_old',
                 audience_import_submitted_at = now() - interval '2 hours'
           WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid`);
      }
      await tx.execute(sql`
        UPDATE broadcasts SET status = 'failed_to_dispatch', failed_to_dispatch_at = now()
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${stale}::uuid`);
    });

    const counted = (await runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
      tx.execute(sql`
        SELECT broadcast_id::text AS id
        FROM broadcasts
        WHERE audience_import_id IS NOT NULL
          AND audience_import_completed_at IS NULL
          AND status::text = 'approved'
          AND audience_import_submitted_at < now() - interval '30 minutes'
          AND broadcast_id IN (${stale}::uuid, ${live}::uuid)`),
    )) as unknown as Array<{ id: string }>;

    const ids = counted.map((r) => r.id);
    // The resolved one is gone from the gauge...
    expect(ids).not.toContain(stale);
    // ...and the genuinely stuck one is still counted. Without this half, a
    // predicate that matched nothing at all would pass the assertion above.
    expect(ids).toContain(live);
  }, 30_000);

  /**
   * S9 — the erasure derivation must see an audience that was PUSHED but never
   * SENT.
   *
   * The delivery-row join cannot: `broadcast_deliveries` is written only by the
   * delivery webhook, and the two-tick build has four refusal modes plus a
   * cancel window that each leave the whole audience at the processor with zero
   * delivery rows. Before the UNION arm the cascade derived nothing for those
   * and still reported `resendOutcome: 'ok'`.
   */
  it('derives an import-built audience with NO delivery rows for erasure', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const slug = asTenantContext(TEST_TENANT).slug;
    const audienceId = `aud-s9-${Date.now()}`;
    const email = `s9-probe-${Date.now()}@example.com`;

    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      await tx.execute(sql`
        UPDATE broadcasts
           SET resend_audience_id = ${audienceId},
               audience_import_id = 'imp_s9',
               audience_import_submitted_at = now()
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`);
    });

    const pairs = await repo.withTx(async (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, slug, [email]),
    );

    expect(pairs).toContainEqual({ audienceId, email });
  }, 30_000);

  /**
   * **This case asserted the OPPOSITE until round 2 R2-3, and the change is
   * deliberate.** It was a positive control for `audience_import_id IS NOT NULL`
   * — "the arm is bounded to the import path that introduced the window".
   *
   * That bound was wrong in the one direction that matters: the LEGACY serial
   * push has the identical pushed-but-never-sent window, and the legacy leg is
   * the one live at merge. The clause therefore covered the dark leg and missed
   * the live one — the third time on this branch a fix landed on one leg only.
   *
   * The arm is still bounded; the bound is now `NOT EXISTS (deliveries)`, which
   * is both narrower where it matters and correct on both legs. The next case is
   * its positive control.
   */
  it('a LEGACY audience with no deliveries IS swept in — the window is not the import path’s alone', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const slug = asTenantContext(TEST_TENANT).slug;
    const audienceId = `aud-s9-legacy-${Date.now()}`;
    const email = `s9-legacy-${Date.now()}@example.com`;

    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      await tx.execute(sql`
        UPDATE broadcasts SET resend_audience_id = ${audienceId}
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`);
    });

    const pairs = await repo.withTx(async (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, slug, [email]),
    );

    expect(pairs).toContainEqual({ audienceId, email });
  }, 30_000);

  /**
   * POSITIVE CONTROL for the bound that replaced it (R2-3). A broadcast that DID
   * deliver is covered by the delivery-row arm, so this arm must not pair its
   * audience with an address that is NOT among its recipients.
   *
   * This is a disclosure control, not an efficiency one:
   * `DELETE /audiences/{id}/contacts/{email}` carries the address in the URL, so
   * pairing an unrelated audience transmits that address to the marketing
   * processor — and the members missing from a sent broadcast's deliveries are
   * missing because `filterMarketingOptedOut` dropped them. Art. 17 is a basis to
   * erase, not to disclose.
   */
  /**
   * Round 4 B-1 — this case is UNCHANGED in what it sets up and INVERTED in what
   * it asserts, which is the point.
   *
   * The fixture is a partially-delivered broadcast: one recipient has a webhook
   * row, the erased member does not. Round 3 read that as "the audience's real
   * recipients are known, so a member missing from them was dropped at resolve"
   * and asserted the address must NOT be sent to Resend — encoding the gap as
   * intended behaviour.
   *
   * `broadcast_deliveries` has one insert site, on the WEBHOOK path. A row means
   * an event arrived, not that the person was in the audience. So this fixture
   * is exactly the state where a live audience still holds an address that no
   * arm returned, while the cascade wrote `ok / 0 detached` into an append-only
   * Art. 30 record.
   *
   * It now asserts coverage.
   */
  it('a PARTIALLY delivered broadcast still pairs a member with no webhook row of their own', async () => {
    if (!RUN_INTEGRATION) return;
    const raw = await seedApproved();
    const repo = makeDrizzleBroadcastsRepo(TEST_TENANT);
    const slug = asTenantContext(TEST_TENANT).slug;
    const audienceId = `aud-s9-delivered-${Date.now()}`;
    const recipient = `s9-got-it-${Date.now()}@example.com`;
    const erased = `s9-opted-out-${Date.now()}@example.com`;

    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      await tx.execute(sql`
        UPDATE broadcasts SET resend_audience_id = ${audienceId}
         WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid`);
      await tx.execute(sql`
        INSERT INTO broadcast_deliveries
          (tenant_id, delivery_id, broadcast_id, recipient_email_lower,
           recipient_member_id, status, event_timestamp, resend_event_id,
           resend_message_id)
        VALUES (${TEST_TENANT}, gen_random_uuid(), ${raw}::uuid, ${recipient},
                NULL, 'delivered', now(), ${'evt-' + String(Date.now())},
                ${'msg-' + String(Date.now())})`);
    });

    const pairs = await repo.withTx(async (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, slug, [erased]),
    );

    // The audience is live (`audience_deleted_at IS NULL`) and one webhook has
    // arrived for somebody else. The erased member has no row of their own —
    // which is indistinguishable from "their event has not come back yet" — so
    // the detach must be attempted rather than assumed unnecessary.
    //
    // If Resend never held the address, the DELETE 404s and the cascade counts
    // it `already_absent`. That is a cost. Writing `ok / detached: 0` over an
    // address still in a live marketing audience is Art. 12(3), in a record
    // that cannot be corrected.
    expect(pairs).toContainEqual({ audienceId, email: erased });
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
