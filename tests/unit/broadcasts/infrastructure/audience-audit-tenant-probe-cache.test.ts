/**
 * Spec 143 (TT3) — one tenant probe per tx for the audience audit.
 *
 * `assertAudienceAuditTenantBoundTx` runs `SELECT current_setting(
 * 'app.current_tenant', TRUE)` to prove the tx is bound to the tenant. The
 * reclaim runs two audience audit calls per segment on one tx (the disclosure
 * read, then `emitOnce` or the existence read), and `runInTenant` sets the
 * GUC once per tx, so the second probe can only repeat the first's answer.
 * Once a tx has been proven bound to a slug, the same slug skips the probe; a
 * different slug probes again (and is refused on a mismatch); a refused or
 * failed probe proves nothing and caches nothing.
 *
 * Review round 1 (code-review #1, #4): the proof is kept only for a tx that
 * `runInTenant` opened, i.e. one registered with `bindTenantTx` under the
 * expected slug. The bare `db` singleton, or any object nobody registered,
 * probes on every call; a tx registered under another slug is refused. So
 * `recordingTx` registers its tx where it models a `runInTenant` tx.
 *
 * Review round 1 (code-review #3): the two reads refuse a `tenantIdArg` other
 * than the repo's own slug before any SQL.
 *
 * The statements are rendered by a real Drizzle instance over `pg-proxy`, as
 * in `broadcast-retime-refusal-probe.test.ts`, so the probe count is the count
 * of `current_setting` statements the tx was sent. The cross-tenant cells on
 * live Neon stay in `audience-audit-rows.test.ts` and
 * `tx-tenant-binding-guard.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { bindTenantTx } from '@/lib/db';
import { AuditPortInvariantError, type AudienceDeletedEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

const TENANT_A = 'tenant-probe-cache-a';
const TENANT_B = 'tenant-probe-cache-b';
const AUDIENCE_ID = 'aud-probe-cache-1';

interface RecordingTx {
  readonly tx: unknown;
  readonly sent: string[];
  /** The `current_setting` probes the tx answered. */
  probes(): number;
}

/**
 * A tx whose GUC answers `tenants[i]` on the i-th probe (the last one after
 * that); every other read finds nothing. `registeredAs` is the slug
 * `bindTenantTx` records for it, as `runInTenant` does; `null` leaves it
 * unregistered, like the bare `db` singleton.
 */
function recordingTx(tenants: ReadonlyArray<string | null>, registeredAs: string | null): RecordingTx {
  const sent: string[] = [];
  let probe = 0;
  const tx = drizzle(async (sqlText) => {
    sent.push(sqlText);
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      const answer = tenants[Math.min(probe, tenants.length - 1)] ?? null;
      probe++;
      return { rows: [{ current_tenant: answer }] };
    }
    if (/^\s*INSERT INTO audit_log/i.test(sqlText)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT EXISTS/i.test(sqlText)) return { rows: [{ found: false }] };
    return { rows: [] };
  });
  if (registeredAs !== null) bindTenantTx(tx, registeredAs);
  return { tx, sent, probes: () => sent.filter((s) => s.includes("current_setting('app.current_tenant'")).length };
}

function deletedInput(tenantId: string): AudienceDeletedEmitInput {
  return {
    eventType: 'broadcast_audience_deleted',
    actorUserId: 'system:cron',
    summary: 'spec 143 fixture',
    tenantId,
    requestId: null,
    payload: {
      broadcast_id: 'b-1',
      related_member_id: 'm-1',
      resend_audience_id: AUDIENCE_ID,
      leg: 'import',
      actor_role: 'system',
      reason: 'orphan_reclaim',
    },
  };
}

const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe('spec 143 TT3 — the audience audit tenant probe runs once per tx and slug', () => {
  it("a disclosed segment's reclaim (disclosure read, then emitOnce) probes once", async () => {
    const t = recordingTx([TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    expect(await repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID)).toBeNull();
    expect(await f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_A))).toBe(true);
    expect(t.probes()).toBe(1);
    // The rendered ON CONFLICT is migration 0328's key and predicate, as literal SQL.
    const insert = t.sent.find((s) => /INSERT INTO audit_log/.test(s));
    expect(insert).toContain(
      "ON CONFLICT (tenant_id, (payload->>'resend_audience_id')) WHERE event_type = 'broadcast_audience_deleted' DO NOTHING RETURNING 1",
    );
  });

  it("an undisclosed segment's reclaim (disclosure read, then the existence read) probes once", async () => {
    const t = recordingTx([TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID);
    expect(await repo.hasAudienceDeletedAuditInTx(t.tx, TENANT_A as never, AUDIENCE_ID)).toBe(false);
    expect(t.probes()).toBe(1);
    // The rendered read keeps the index's predicate and key expression as literal SQL.
    const read = t.sent.find((s) => /SELECT EXISTS/.test(s));
    expect(read).toMatch(/WHERE tenant_id = \$1\s+AND event_type = 'broadcast_audience_deleted'\s+AND payload->>'resend_audience_id' = \$2::text/);
  });

  it('a second slug on the same tx probes again and is refused as an invariant error', async () => {
    const t = recordingTx([TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID);
    const e = await caught(f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_B)));
    expect(e).toBeInstanceOf(AuditPortInvariantError);
    expect((e as Error).message).toMatch(/tx tenant mismatch/);
    expect(t.probes()).toBe(2);
    expect(t.sent.some((s) => /INSERT INTO audit_log/.test(s))).toBe(false);
  });

  it('a refused first probe caches nothing: the next call probes again', async () => {
    const t = recordingTx([TENANT_B, TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    const e = await caught(repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID));
    expect(e).toBeInstanceOf(AuditPortInvariantError);
    expect(await repo.hasAudienceDeletedAuditInTx(t.tx, TENANT_A as never, AUDIENCE_ID)).toBe(false);
    expect(t.probes()).toBe(2);
  });

  it('a tx with no tenant bound is refused on every call, never cached', async () => {
    const t = recordingTx([null], null);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    for (let i = 0; i < 2; i++) {
      const e = await caught(repo.hasAudienceDeletedAuditInTx(t.tx, TENANT_A as never, AUDIENCE_ID));
      expect(e).toBeInstanceOf(AuditPortInvariantError);
      expect((e as Error).message).toMatch(/NOT inside a runInTenant scope/);
    }
    expect(t.probes()).toBe(2);
  });

  it('another tx probes for itself', async () => {
    const first = recordingTx([TENANT_A], TENANT_A);
    const second = recordingTx([TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.findAudienceDisclosureInTx(first.tx, TENANT_A as never, AUDIENCE_ID);
    await repo.findAudienceDisclosureInTx(second.tx, TENANT_A as never, AUDIENCE_ID);
    expect([first.probes(), second.probes()]).toEqual([1, 1]);
  });
});

describe('review round 1 — only a tx runInTenant opened keeps its proof (code-review #1, #4)', () => {
  it('an unregistered object (the bare db singleton) probes on every call, so nothing is cached for it', async () => {
    const t = recordingTx([TENANT_A], null);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID);
    expect(await f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_A))).toBe(true);
    expect(await repo.hasAudienceDeletedAuditInTx(t.tx, TENANT_A as never, AUDIENCE_ID)).toBe(false);
    expect(t.probes()).toBe(3);
  });

  it('a tx runInTenant opened for another slug is refused, even when its GUC answers the expected one', async () => {
    const t = recordingTx([TENANT_A], TENANT_B);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    for (const call of [
      () => repo.findAudienceDisclosureInTx(t.tx, TENANT_A as never, AUDIENCE_ID),
      () => f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_A)),
    ]) {
      const e = await caught(call());
      expect(e).toBeInstanceOf(AuditPortInvariantError);
      expect((e as Error).message).toMatch(/tx tenant mismatch/);
    }
    expect(t.sent.some((s) => /INSERT INTO audit_log|FROM audit_log/.test(s))).toBe(false);
  });
});

describe('review round 1 — the reads refuse a tenantIdArg other than the repo slug before any SQL (code-review #3)', () => {
  it.each([
    ['hasAudienceDeletedAuditInTx', 'broadcast_audience_deleted'],
    ['findAudienceDisclosureInTx', 'broadcast_audience_disclosed'],
  ] as const)('%s', async (method, eventType) => {
    const t = recordingTx([TENANT_A], TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    const e = await caught(repo[method](t.tx, TENANT_B as never, AUDIENCE_ID));
    expect(e).toBeInstanceOf(AuditPortInvariantError);
    expect((e as AuditPortInvariantError).message).toContain(eventType);
    expect(t.sent).toEqual([]);
  });
});
