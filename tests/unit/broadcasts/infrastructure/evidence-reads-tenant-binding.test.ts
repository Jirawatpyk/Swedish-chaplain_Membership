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
 * in `audience-audit-tenant-probe.test.ts`. The live cross-tenant cells stay in
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

/** A tx whose GUC answers `tenant` on every probe; every other read finds nothing. */
function recordingTx(tenant: string) {
  const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes(PROBE)) return { rows: [{ current_tenant: tenant }] };
    return { rows: [] };
  });
  return { tx, sent };
}

describe('spec 143 — the evidence reads bind the repo tenant in the lock key and the predicate', () => {
  it('readAlreadySentEvidenceInTx binds the repo tenant in both', async () => {
    const t = recordingTx(TENANT_A);
    const repo = makeDrizzleBroadcastsRepo(TENANT_A);
    await repo.readAlreadySentEvidenceInTx(t.tx, { memberId: MEMBER_ID, broadcastId: asBroadcastId(BROADCAST_ID) });

    const lock = t.sent.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.sql).toContain("hashtextextended('broadcasts-evidence:' || $1 || ':' || $2, 0)");
    expect(lock?.params).toEqual([TENANT_A, BROADCAST_ID]);
    const read = t.sent.find((s) => s.sql.includes('FROM audit_log'));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$3\s/);
    expect(read?.params).toEqual([BROADCAST_ID, MEMBER_ID, TENANT_A]);
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
});
