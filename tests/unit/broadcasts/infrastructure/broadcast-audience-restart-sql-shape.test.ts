/**
 * The SQL the Drizzle adapter sends for the import leg's restart writes — the
 * two compare-and-sets a HOLD (or the audience-missing self-heal) makes — and
 * for the two fenced attaches on the sending side.
 *
 * A fake repo cannot see the contract, which is all in the statements.
 *
 * `releaseAudienceImport` is the CLAIM. The dispatch cron holds no lease past
 * its scan, so the row is the mutex: a hold must win this CAS before it may
 * delete anything a sibling tick could be sending.
 *   - it NULLs `audience_import_id` + `audience_import_submitted_at` together
 *     (0299's coherence CHECK pairs them) — the column the sender's attach is
 *     fenced on — and NOTHING else: not `resend_broadcast_id` (a refused
 *     broadcast delete must leave it for the next tick's probe), not
 *     `resend_audience_id` (erasure and `cleanup-audiences` still see the
 *     audience until it is deleted), not `audience_import_completed_at` (the
 *     WHERE requires it NULL already), not `status`;
 *   - it compares the import id and the audience id by `=`, the broadcast id
 *     NULL-safe (`IS NOT DISTINCT FROM` — the common hold has none), on a row
 *     still `approved` with no completion stamp.
 *
 * `releaseResendAudience` runs only after both deletes: it NULLs the audience
 * AND the broadcast id together, only while the row carries no import, and
 * only while both still equal what was deleted (the broadcast id NULL-safe).
 *
 * `attachBroadcastId` — an EMPTY id on the row is not an id (it is treated as
 * NULL, so a `''` row does not loop mint → CAS-fail → reclaim for ever); the
 * optional fence adds `audience_import_id = $expected` (a hold that claimed the
 * row since Step 1 makes the sender's attach lose, so it does not send) and,
 * for a dead inherited id, `OR resend_broadcast_id = $dead` so the fresh id may
 * replace it. `attachAudienceImport`'s optional fence adds
 * `resend_audience_id = $expected`, so an import never lands on a row whose
 * audience a hold released in the meantime.
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
const DELETED = { resendAudienceId: 'aud-held', resendBroadcastId: 'rb-held' } as const;

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

/** The parameter a `"col" = $n` in the SET list binds — and that it is there. */
function setParam(u: Sent, col: string): unknown {
  const slot = new RegExp(`"${col}"\\s*=\\s*\\$(\\d+)`).exec(setList(u));
  expect(slot, `the SET list does not write ${col}`).not.toBeNull();
  return u.params[Number(slot?.[1]) - 1];
}

/** The parameter a `"col" is not distinct from $n` predicate binds. */
function nullSafeParam(u: Sent, col: string): unknown {
  const slot = new RegExp(`"${col}"\\s+is\\s+not\\s+distinct\\s+from\\s+\\$(\\d+)`, 'i').exec(whereOf(u));
  expect(slot, `${col} is not compared NULL-safe`).not.toBeNull();
  return u.params[Number(slot?.[1]) - 1];
}

/** Every parameter bound by a `"broadcasts"."resend_broadcast_id" = $n` arm. */
function broadcastIdArms(u: Sent): unknown[] {
  return [...whereOf(u).matchAll(/"broadcasts"\."resend_broadcast_id"\s*=\s*\$(\d+)/g)].map(
    (m) => u.params[Number(m[1]) - 1],
  );
}

describe('releaseAudienceImport (the restart\'s claim) — SQL shape', () => {
  it('NULLs the import id and its submit stamp ONLY; CAS on all three ids, approved, not completed', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(true);

    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    expect(setParam(update, 'audience_import_id')).toBeNull();
    expect(setParam(update, 'audience_import_submitted_at')).toBeNull();
    const set = setList(update);
    for (const col of ['resend_broadcast_id', 'resend_audience_id', 'audience_import_completed_at', 'status']) {
      expect(set, `the SET list must not write ${col}`).not.toMatch(new RegExp(`"${col}"`));
    }
    const where = whereOf(update);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."resend_audience_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."audience_import_id"\s*=\s*\$\d+/);
    expect(nullSafeParam(update, 'resend_broadcast_id')).toBe('rb-held');
    expect(where).toMatch(/"broadcasts"\."audience_import_completed_at"\s+is\s+null/i);
    expect(update.params).toEqual(expect.arrayContaining([TENANT, BROADCAST_ID, 'approved', 'aud-held', 'imp-held']));
  });

  it('a row with NO broadcast id is matched by a NULL parameter, not by a separate IS NULL arm', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, { ...EXPECTED, resendBroadcastId: null });

    expect(nullSafeParam(theUpdate(sent), 'resend_broadcast_id')).toBeNull();
  });

  it('matching no row (the claim lost) answers false, not a throw', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(false);
  });
});

describe('releaseResendAudience (after both deletes) — SQL shape', () => {
  it('NULLs the audience AND the broadcast id together, only with no import and both still equal to what was deleted', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseResendAudience(tx, TENANT as never, BROADCAST_ID, DELETED)).resolves.toBe(true);

    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    expect(setParam(update, 'resend_audience_id')).toBeNull();
    expect(setParam(update, 'resend_broadcast_id')).toBeNull();
    const set = setList(update);
    for (const col of ['audience_import_id', 'audience_import_submitted_at', 'status']) {
      expect(set, `the SET list must not write ${col}`).not.toMatch(new RegExp(`"${col}"`));
    }
    const where = whereOf(update);
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."resend_audience_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."audience_import_id"\s+is\s+null/i);
    expect(nullSafeParam(update, 'resend_broadcast_id')).toBe('rb-held');
    expect(update.params).toEqual(expect.arrayContaining([TENANT, BROADCAST_ID, 'approved', 'aud-held']));
  });

  it('a row with NO broadcast id is matched by a NULL parameter', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.releaseResendAudience(tx, TENANT as never, BROADCAST_ID, { ...DELETED, resendBroadcastId: null });

    expect(nullSafeParam(theUpdate(sent), 'resend_broadcast_id')).toBeNull();
  });

  it('matching no row answers false, not a throw', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.releaseResendAudience(tx, TENANT as never, BROADCAST_ID, DELETED)).resolves.toBe(false);
  });
});

describe('attachBroadcastId — the empty-id arm, the import-id fence, the dead-id replacement', () => {
  it("treats an EMPTY resend_broadcast_id on the row as NULL (no mint → CAS-fail → reclaim loop on a '' row)", async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new');

    const update = theUpdate(sent);
    expect(broadcastIdArms(update)).toEqual(expect.arrayContaining(['', 'rb-new']));
    expect(whereOf(update)).toMatch(/"broadcasts"\."resend_broadcast_id"\s+is\s+null/i);
  });

  it('without a fence (the legacy leg) there is no audience_import_id predicate and no third id arm', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new');

    const update = theUpdate(sent);
    expect(whereOf(update)).not.toMatch(/"audience_import_id"/);
    expect(broadcastIdArms(update)).toHaveLength(2);
  });

  it('with the fence (the import leg) the attach only lands while the row still carries the expected import', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new', { expectedAudienceImportId: 'imp-held' });

    const update = theUpdate(sent);
    const slot = /"broadcasts"\."audience_import_id"\s*=\s*\$(\d+)/.exec(whereOf(update));
    expect(slot, 'the fence predicate is missing').not.toBeNull();
    expect(update.params[Number(slot?.[1]) - 1]).toBe('imp-held');
    expect(broadcastIdArms(update)).toHaveLength(2);
  });

  it('replacing a DEAD inherited id: the CAS also admits exactly that id, still fenced on the import', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachBroadcastId(tx, TENANT as never, BROADCAST_ID, 'rb-new', {
      expectedAudienceImportId: 'imp-held',
      replacesResendBroadcastId: 'rb-dead',
    });

    const update = theUpdate(sent);
    expect(broadcastIdArms(update)).toEqual(expect.arrayContaining(['', 'rb-new', 'rb-dead']));
    expect(whereOf(update)).toMatch(/"broadcasts"\."audience_import_id"\s*=\s*\$\d+/);
  });
});

describe('attachAudienceImport — the optional audience fence', () => {
  it('with the fence the import lands only while the row still carries the expected audience', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachAudienceImport(tx, TENANT as never, BROADCAST_ID, 'imp-new', { expectedResendAudienceId: 'aud-held' });

    const update = theUpdate(sent);
    const slot = /"broadcasts"\."resend_audience_id"\s*=\s*\$(\d+)/.exec(whereOf(update));
    expect(slot, 'the audience fence is missing').not.toBeNull();
    expect(update.params[Number(slot?.[1]) - 1]).toBe('aud-held');
  });

  it('without the fence there is no audience predicate', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.attachAudienceImport(tx, TENANT as never, BROADCAST_ID, 'imp-new');

    expect(whereOf(theUpdate(sent))).not.toMatch(/"resend_audience_id"/);
  });
});

/**
 * A sender that passed the fence before a hold's claim can still reach the
 * post-send stamp after the claim released the import. The stamp must not
 * land on such a row — `completed_at` with no import and no submit stamp is
 * the shape 0299 forbids — so its WHERE requires an import to complete.
 */
describe('markAudienceImportCompleted — only an import that is still there', () => {
  it('requires audience_import_id IS NOT NULL as well as an unstamped completion', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.markAudienceImportCompleted(tx, TENANT as never, BROADCAST_ID);

    const where = whereOf(theUpdate(sent));
    expect(where).toMatch(/"broadcasts"\."audience_import_id"\s+is\s+not\s+null/i);
    expect(where).toMatch(/"broadcasts"\."audience_import_completed_at"\s+is\s+null/i);
  });
});
