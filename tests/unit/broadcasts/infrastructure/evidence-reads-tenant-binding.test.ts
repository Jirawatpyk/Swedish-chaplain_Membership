/**
 * Spec 143 — the two evidence reads bind the repo's own tenant.
 *
 * `readAlreadySentEvidenceInTx` and `hasUnverifiableCountAuditInTx` take no
 * tenant argument: the advisory-lock key and the `tenant_id` predicate both
 * bind `ctx.slug`, the tenant `assertTenantBoundTx` proved the tx bound to.
 * The lock key keeps its template text, so an equal slug hashes to the same
 * key as before and concurrent callers still serialise.
 *
 * The statements are rendered by a real Drizzle instance over `pg-proxy`, as
 * in `audience-audit-tenant-probe.test.ts`. Each read is answered with the one
 * row Postgres returns for it, so a cell never reads `false` through the
 * repo's handling of an empty result. The live cross-tenant cells stay in
 * `already-sent-evidence.test.ts` and `audience-import-repo.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

const TENANT_A = 'tenant-evidence-a';
const TENANT_B = 'tenant-evidence-b';
const BROADCAST_ID = '0b5e3c1a-7d2f-4c8e-9a61-3f0d2b7e4c15';
const MEMBER_ID = 'member-evidence-1';
const RESEND_BROADCAST_ID = 'rb-evidence-1';
const PROBE = "current_setting('app.current_tenant'";

/**
 * A tx whose GUC answers `tenant` on every probe (`null`: unset, as on the bare
 * db). Every other statement gets the row Postgres returns when no evidence
 * row matches: the lock's void row, the EXISTS's `false`, the aggregate's
 * `false` and `0`.
 */
function recordingTx(tenant: string | null) {
  const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes(PROBE)) return { rows: [{ current_tenant: tenant }] };
    if (sqlText.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: '' }] };
    if (sqlText.includes('EXISTS')) return { rows: [{ found: false }] };
    if (sqlText.includes('broadcast_recorded')) return { rows: [{ broadcast_recorded: false, member_count: 0 }] };
    throw new Error(`recordingTx: unexpected statement ${sqlText}`);
  });
  return { tx, sent };
}

describe('spec 143 — the evidence reads bind the repo tenant in the lock key and the predicate', () => {
  it('readAlreadySentEvidenceInTx binds the repo tenant in both', async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    expect(
      await repo.readAlreadySentEvidenceInTx(t.tx, { memberId: MEMBER_ID, broadcastId: asBroadcastId(BROADCAST_ID) }),
    ).toEqual({ broadcastRecorded: false, memberBroadcastCount: 0 });

    const lock = t.sent.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.sql).toContain("hashtextextended('broadcasts-evidence:' || $1 || ':' || $2, 0)");
    expect(lock?.params).toEqual([TENANT_A, BROADCAST_ID]);
    const read = t.sent.find((s) => s.sql.includes('FROM audit_log'));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$3\s/);
    expect(read?.params).toEqual([BROADCAST_ID, MEMBER_ID, TENANT_A]);
  });

  // The erasure count (`cancel-in-flight-broadcasts-for-member.ts`) reads with
  // no broadcast: no lock is taken, and the predicate still binds the repo tenant.
  it('readAlreadySentEvidenceInTx with broadcastId null binds the repo tenant and takes no lock', async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    expect(await repo.readAlreadySentEvidenceInTx(t.tx, { memberId: MEMBER_ID, broadcastId: null })).toEqual({
      broadcastRecorded: false,
      memberBroadcastCount: 0,
    });

    expect(t.sent.some((s) => s.sql.includes('pg_advisory_xact_lock'))).toBe(false);
    const read = t.sent.find((s) => s.sql.includes('FROM audit_log'));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$3\s/);
    expect(read?.params).toEqual([null, MEMBER_ID, TENANT_A]);
    expect(t.sent).toHaveLength(2);
  });

  it('hasUnverifiableCountAuditInTx binds the repo tenant in both', async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    expect(await repo.hasUnverifiableCountAuditInTx(t.tx, asBroadcastId(BROADCAST_ID), RESEND_BROADCAST_ID)).toBe(false);

    const lock = t.sent.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.sql).toContain("hashtextextended('broadcasts-unverifiable:' || $1 || ':' || $2, 0)");
    expect(lock?.params).toEqual([TENANT_A, BROADCAST_ID]);
    const read = t.sent.find((s) => s.sql.includes('FROM audit_log'));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$1\s/);
    expect(read?.params).toEqual([TENANT_A, BROADCAST_ID, RESEND_BROADCAST_ID]);
  });

  it('a tx bound to another tenant is refused before the lock or the read', async () => {
    const t = recordingTx(TENANT_B);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await expect(
      repo.readAlreadySentEvidenceInTx(t.tx, { memberId: MEMBER_ID, broadcastId: asBroadcastId(BROADCAST_ID) }),
    ).rejects.toThrow(/tx tenant mismatch/);
    await expect(
      repo.hasUnverifiableCountAuditInTx(t.tx, asBroadcastId(BROADCAST_ID), RESEND_BROADCAST_ID),
    ).rejects.toThrow(/tx tenant mismatch/);
    expect(t.sent.some((s) => /pg_advisory_xact_lock|FROM audit_log/.test(s.sql))).toBe(false);
  });

  it('a tx with no tenant bound (the probe answers NULL) is refused before the lock or the read', async () => {
    const t = recordingTx(null);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    for (const broadcastId of [asBroadcastId(BROADCAST_ID), null]) {
      await expect(repo.readAlreadySentEvidenceInTx(t.tx, { memberId: MEMBER_ID, broadcastId })).rejects.toThrow(
        /NOT inside a runInTenant scope/,
      );
    }
    await expect(
      repo.hasUnverifiableCountAuditInTx(t.tx, asBroadcastId(BROADCAST_ID), RESEND_BROADCAST_ID),
    ).rejects.toThrow(/NOT inside a runInTenant scope/);

    expect(t.sent).toHaveLength(3);
    expect(t.sent.every((s) => s.sql.includes(PROBE))).toBe(true);
  });
});
