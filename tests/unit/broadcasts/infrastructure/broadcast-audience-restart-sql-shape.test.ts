/**
 * The SQL the Drizzle adapter sends for the import leg's restart writes — the
 * two compare-and-sets a HOLD (or the audience-missing self-heal) makes — and
 * for the sender's fenced `attachBroadcastId`.
 *
 * A fake repo cannot see the contract, which is all in the statements.
 *
 * `releaseAudienceImport` is the CLAIM. The dispatch cron holds no lease past
 * its scan, so the row is the mutex: a hold must win this CAS before it may
 * delete the audience a sibling tick could be sending into.
 *   - it NULLs `audience_import_id` + `audience_import_submitted_at` together
 *     (0299's coherence CHECK pairs them) and `resend_broadcast_id`, and never
 *     writes `resend_audience_id` (erasure and `cleanup-audiences` still see the
 *     audience until it is deleted), `audience_import_completed_at` (the WHERE
 *     requires it NULL already) or `status`;
 *   - it compares the import id and the broadcast id NULL-safe
 *     (`IS NOT DISTINCT FROM` — a row with no import, or no broadcast id, is
 *     matched by a NULL parameter), the audience id by `=`, on a row still
 *     `approved` with no completion stamp.
 *
 * `releaseResendAudience` runs only after the audience delete: it NULLs that
 * column alone, and only while the row carries no import and no broadcast id.
 *
 * `attachBroadcastId` — an EMPTY id on the row is not an id (it is treated as
 * NULL, so a `''` row does not loop mint → CAS-fail → reclaim for ever), and the
 * optional fence adds `audience_import_id = $expected`: a hold that claimed the
 * row since Step 1 makes the sender's attach lose, so it does not send.
 *
 * Rendered by a real Drizzle instance over `pg-proxy`, as in
 * `broadcast-dispatch-retry-epoch-sql-shape.test.ts`. What Postgres admits is
 * proven on live Neon in `tests/integration/broadcasts/audience-import-repo.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

const TENANT = 'tenant-restart-import';
const BROADCAST_ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000d1');
const EXPECTED = { importId: 'imp-held', resendAudienceId: 'aud-held', resendBroadcastId: 'rb-held' } as const;

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function recordingTx(returned: unknown[][] = []): { tx: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      return { rows: [{ current_tenant: TENANT }] };
    }
    if (/\breturning\b/i.test(sqlText)) return { rows: returned };
    return { rows: [] };
  });
  return { tx, sent };
}

function theUpdate(sent: readonly Sent[]): Sent {
  const update = sent.find((s) => /^update "broadcasts"/i.test(s.sql));
  expect(update, 'no UPDATE on broadcasts was sent').toBeDefined();
  return update as Sent;
}

const setList = (u: Sent): string => /\bset\b([\s\S]*?)\bwhere\b/i.exec(u.sql)?.[1] ?? '';
const whereOf = (u: Sent): string => u.sql.slice(u.sql.search(/\bwhere\b/i));

/** The parameter a `"col" is not distinct from $n` predicate binds. */
function nullSafeParam(u: Sent, col: string): unknown {
  const slot = new RegExp(`"${col}"\\s+is\\s+not\\s+distinct\\s+from\\s+\\$(\\d+)`, 'i').exec(whereOf(u));
  expect(slot, `${col} is not compared NULL-safe`).not.toBeNull();
  return u.params[Number(slot?.[1]) - 1];
}

describe('releaseAudienceImport (the hold\'s claim) — SQL shape', () => {
  it('NULLs the import id, its submit stamp and the broadcast id; keeps the audience; CAS on all three ids, approved, not completed', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(true);

    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    const set = setList(update);
    for (const col of ['audience_import_id', 'audience_import_submitted_at', 'resend_broadcast_id']) {
      const slot = new RegExp(`"${col}"\\s*=\\s*\\$(\\d+)`).exec(set);
      expect(slot, `the SET list does not write ${col}`).not.toBeNull();
      expect(update.params[Number(slot?.[1]) - 1]).toBeNull();
    }
    for (const col of ['resend_audience_id', 'audience_import_completed_at', 'status']) {
      expect(set, `the SET list must not write ${col}`).not.toMatch(new RegExp(`"${col}"`));
    }
    const where = whereOf(update);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."resend_audience_id"\s*=\s*\$\d+/);
    expect(nullSafeParam(update, 'audience_import_id')).toBe('imp-held');
    expect(nullSafeParam(update, 'resend_broadcast_id')).toBe('rb-held');
    expect(where).toMatch(/"broadcasts"\."audience_import_completed_at"\s+is\s+null/i);
    expect(update.params).toEqual(expect.arrayContaining([TENANT, BROADCAST_ID, 'approved', 'aud-held']));
  });

  it('a row with NO import and NO broadcast id is matched by NULL parameters, not by separate IS NULL arms', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, {
      importId: null,
      resendAudienceId: 'aud-held',
      resendBroadcastId: null,
    });

    const update = theUpdate(sent);
    expect(nullSafeParam(update, 'audience_import_id')).toBeNull();
    expect(nullSafeParam(update, 'resend_broadcast_id')).toBeNull();
  });

  it('matching no row (the claim lost) answers false, not a throw', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(false);
  });
});

describe('releaseResendAudience (after the audience delete) — SQL shape', () => {
  it('NULLs resend_audience_id alone, only while the row carries no import and no broadcast id', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseResendAudience(tx, TENANT as never, BROADCAST_ID, 'aud-held')).resolves.toBe(true);

    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    const set = setList(update);
    const slot = /"resend_audience_id"\s*=\s*\$(\d+)/.exec(set);
    expect(slot, 'the SET list does not write resend_audience_id').not.toBeNull();
    expect(update.params[Number(slot?.[1]) - 1]).toBeNull();
    for (const col of ['resend_broadcast_id', 'audience_import_id', 'audience_import_submitted_at', 'status']) {
      expect(set, `the SET list must not write ${col}`).not.toMatch(new RegExp(`"${col}"`));
    }
    const where = whereOf(update);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."resend_audience_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."audience_import_id"\s+is\s+null/i);
    expect(where).toMatch(/"broadcasts"\."resend_broadcast_id"\s+is\s+null/i);
    expect(update.params).toEqual(expect.arrayContaining([TENANT, BROADCAST_ID, 'approved', 'aud-held']));
  });

  it('matching no row answers false, not a throw', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseResendAudience(tx, TENANT as never, BROADCAST_ID, 'aud-held')).resolves.toBe(false);
  });
});

describe('attachBroadcastId — the empty-id arm and the sender\'s import-id fence', () => {
  it("treats an EMPTY resend_broadcast_id on the row as NULL (no mint → CAS-fail → reclaim loop on a '' row)", async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new');

    const update = theUpdate(sent);
    const where = whereOf(update);
    const emptyArm = /"broadcasts"\."resend_broadcast_id"\s*=\s*\$(\d+)/g;
    const bound = [...where.matchAll(emptyArm)].map((m) => update.params[Number(m[1]) - 1]);
    expect(bound).toEqual(expect.arrayContaining(['', 'rb-new']));
    expect(where).toMatch(/"broadcasts"\."resend_broadcast_id"\s+is\s+null/i);
  });

  it('without a fence (the legacy leg) there is no audience_import_id predicate', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new');

    expect(whereOf(theUpdate(sent))).not.toMatch(/"audience_import_id"/);
  });

  it('with the fence (the import leg) the attach only lands while the row still carries the expected import', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new', { expectedAudienceImportId: 'imp-held' });

    const update = theUpdate(sent);
    const slot = /"broadcasts"\."audience_import_id"\s*=\s*\$(\d+)/.exec(whereOf(update));
    expect(slot, 'the fence predicate is missing').not.toBeNull();
    expect(update.params[Number(slot?.[1]) - 1]).toBe('imp-held');
  });
});
