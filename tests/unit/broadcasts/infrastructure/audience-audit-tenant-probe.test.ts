/**
 * Spec 143 — the audience audit tenant probe runs on every call.
 *
 * `assertAudienceAuditTenantBoundTx` runs `SELECT current_setting(
 * 'app.current_tenant', TRUE)` to prove the tx is bound to the repo's tenant,
 * and refuses a tx bound to another tenant (or to none) as an
 * `AuditPortInvariantError`, before any audit SQL. The reclaim's two calls
 * per segment (the disclosure read, then `emitOnce` or the existence read)
 * probe twice.
 *
 * Review round 2 (maintainer, 7 Nov 2026): TT3's per-tx probe cache was
 * reverted. It saved at most one ~30 ms probe per reclaimed segment, and its
 * safety rested on a single-writer scan of `app.current_tenant` that could not
 * be made complete. These cells pin the fail-closed probe it would have
 * skipped.
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

const TENANT_A = 'tenant-probe-a';
const TENANT_B = 'tenant-probe-b';
const AUDIENCE_ID = 'aud-probe-1';
const PROBE = "current_setting('app.current_tenant'";

interface RecordingTx {
  readonly tx: unknown;
  readonly sent: Array<{ readonly sql: string; readonly params: readonly unknown[] }>;
  /** The `current_setting` probes the tx answered. */
  probes(): number;
}

/**
 * A tx whose GUC answers `tenant` on every probe; every other read finds
 * nothing. A tx with a tenant is registered with `bindTenantTx`, as
 * `runInTenant` registers every tx it opens; one with none is not, like the
 * bare `db` singleton.
 */
function recordingTx(tenant: string | null): RecordingTx {
  const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes(PROBE)) return { rows: [{ current_tenant: tenant }] };
    if (/^\s*INSERT INTO audit_log/i.test(sqlText)) return { rows: [{ '?column?': 1 }] };
    if (/SELECT EXISTS/i.test(sqlText)) return { rows: [{ found: false }] };
    return { rows: [] };
  });
  if (tenant !== null) bindTenantTx(tx, tenant);
  return { tx, sent, probes: () => sent.filter((s) => s.sql.includes(PROBE)).length };
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

describe('spec 143 — the audience audit tenant probe runs on every call', () => {
  it("a disclosed segment's reclaim (disclosure read, then emitOnce) probes twice", async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    expect(await repo.findAudienceDisclosureInTx(t.tx, AUDIENCE_ID)).toBeNull();
    expect(await f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_A))).toBe(true);
    expect(t.probes()).toBe(2);
    // The rendered ON CONFLICT is migration 0328's key and predicate, as literal SQL.
    const insert = t.sent.find((s) => /INSERT INTO audit_log/.test(s.sql));
    expect(insert?.sql).toContain(
      "ON CONFLICT (tenant_id, (payload->>'resend_audience_id')) WHERE event_type = 'broadcast_audience_deleted' DO NOTHING RETURNING 1",
    );
  });

  it("an undisclosed segment's reclaim (disclosure read, then the existence read) probes twice", async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.findAudienceDisclosureInTx(t.tx, AUDIENCE_ID);
    expect(await repo.hasAudienceDeletedAuditInTx(t.tx, AUDIENCE_ID)).toBe(false);
    expect(t.probes()).toBe(2);
    // The rendered read keeps the index's predicate and key expression as literal SQL.
    const read = t.sent.find((s) => /SELECT EXISTS/.test(s.sql));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$1\s+AND event_type = 'broadcast_audience_deleted'\s+AND payload->>'resend_audience_id' = \$2::text/);
    // Review round 2 (code-review finding 6): both reads bind the repo's own
    // tenant; neither takes a tenant argument a caller could get wrong.
    expect(read?.params).toEqual([TENANT_A, AUDIENCE_ID]);
    const disclosure = t.sent.find((s) => /broadcast_audience_disclosed/.test(s.sql));
    expect(disclosure?.sql).toMatch(/WHERE tenant_id = \$3\s/);
    expect(disclosure?.params[2]).toBe(TENANT_A);
  });

  it('a tx bound to another tenant is refused as an invariant error on every call, before any audit SQL', async () => {
    const t = recordingTx(TENANT_B);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    for (const call of [
      () => repo.findAudienceDisclosureInTx(t.tx, AUDIENCE_ID),
      () => repo.hasAudienceDeletedAuditInTx(t.tx, AUDIENCE_ID),
      () => f7AuditAdapter.emitOnce(t.tx, deletedInput(TENANT_A)),
    ]) {
      const e = await caught(call());
      expect(e).toBeInstanceOf(AuditPortInvariantError);
      expect((e as Error).message).toMatch(/tx tenant mismatch/);
    }
    expect(t.probes()).toBe(3);
    expect(t.sent.some((s) => /INSERT INTO audit_log|FROM audit_log/.test(s.sql))).toBe(false);
  });

  it('a tx with no tenant bound (the bare db singleton) is refused on every call', async () => {
    const t = recordingTx(null);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    for (let i = 0; i < 2; i++) {
      const e = await caught(repo.hasAudienceDeletedAuditInTx(t.tx, AUDIENCE_ID));
      expect(e).toBeInstanceOf(AuditPortInvariantError);
      expect((e as Error).message).toMatch(/NOT inside a runInTenant scope/);
    }
    expect(t.probes()).toBe(2);
  });
});
