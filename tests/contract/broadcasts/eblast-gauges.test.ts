/**
 * F119 T121 — the four E-Blast approval-stage gauges on the EXISTING
 * broadcasts half of GET /api/internal/metrics/broadcasts-gauges
 * (`contracts/dashboard-and-notifications.md` § 4.1 — no new cron, no new
 * transaction, same `observed` tenant set, same zero-fill convention):
 *
 *   broadcasts_awaiting_member_approval_count{tenant}
 *   broadcasts_awaiting_member_oldest_age_seconds{tenant}
 *   broadcasts_changes_requested_count{tenant}
 *   broadcasts_marketing_turn_count{tenant}
 *
 * and `broadcasts_queue_pending` stays on `('submitted','approved')` — its
 * alert threshold (`docs/observability.md` § 22.3) is calibrated to it.
 *
 * The REAL broadcasts transaction callback runs against a recording `tx`
 * double that answers by SQL text: a mock that returns canned rows whatever
 * ran cannot tell a widened `queue_pending` IN-list from the original one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbTransactionMock = vi.fn();
const queuePendingSpy = vi.fn();
const awaitingCountSpy = vi.fn();
const awaitingOldestAgeSpy = vi.fn();
const changesRequestedCountSpy = vi.fn();
const marketingTurnCountSpy = vi.fn();

// F119 T132 — the route derives the marketing-turn set from the broadcasts
// barrel's Domain constant; the barrel itself (db, env, adapters) is not what
// this wire contract is about, so only the constant is provided — the REAL one.
vi.mock('@/modules/broadcasts', async () => ({
  MARKETING_TURN_STATUSES: (await import('@/modules/broadcasts/domain/stage/whose-turn')).MARKETING_TURN_STATUSES,
}));
vi.mock('@/lib/env', () => ({
  env: { isDevelopment: false, features: { memberChangeApproval: true } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: { transaction: (...args: unknown[]) => dbTransactionMock(...args) },
}));
vi.mock('@/lib/cron-auth', () => ({
  verifyCronBearer: (header: string | null, expected: string) => header === `Bearer ${expected}`,
}));
vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      queuePending: queuePendingSpy,
      stuckSendingCount: vi.fn(),
      approvedOverdueCount: vi.fn(),
      audienceImportStuckCount: vi.fn(),
      suppressionListSize: vi.fn(),
      dispatchFailureRate: vi.fn(),
      forgetDispatchFailureRate: vi.fn(),
      awaitingMemberApprovalCount: awaitingCountSpy,
      awaitingMemberOldestAgeSeconds: awaitingOldestAgeSpy,
      changesRequestedCount: changesRequestedCountSpy,
      marketingTurnCount: marketingTurnCountSpy,
    },
    membersMetrics: {
      ...actual.membersMetrics,
      changeRequests: {
        ...actual.membersMetrics.changeRequests,
        pendingCount: vi.fn(),
        oldestAgeSeconds: vi.fn(),
        forgetGauges: vi.fn(),
      },
    },
  };
});

/** The text of a drizzle sql template — enough to tell WHICH statement ran. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => (typeof c === 'object' && c !== null && 'value' in c ? (c as { value: readonly string[] }).value.join('') : ' ? '))
    .join('');
}

interface BroadcastsRows {
  readonly tenantRows: readonly unknown[];
  readonly pendingRows: readonly unknown[];
  readonly eblastStageRows: readonly unknown[];
}

/** Runs the REAL broadcasts callback; answers each statement by its text. */
function recordBroadcastsTx(rows: BroadcastsRows): string[] {
  const statements: string[] = [];
  dbTransactionMock.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      execute: async (q: unknown) => {
        const text = sqlText(q);
        statements.push(text);
        if (/awaiting_member_approval/.test(text)) return rows.eblastStageRows;
        if (/SELECT DISTINCT tenant_id FROM broadcasts/.test(text)) return rows.tenantRows;
        if (/status::text IN \('submitted', 'approved'\)/.test(text)) return rows.pendingRows;
        return [];
      },
    };
    return fn(tx);
  });
  // the members half — quiet
  dbTransactionMock.mockImplementationOnce(async () => ({ tenantRows: [], pendingRows: [] }));
  return statements;
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/internal/metrics/broadcasts-gauges', {
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  for (const m of [dbTransactionMock, queuePendingSpy, awaitingCountSpy, awaitingOldestAgeSpy, changesRequestedCountSpy, marketingTurnCountSpy]) {
    m.mockReset();
  }
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/internal/metrics/broadcasts-gauges — F119 E-Blast stage gauges (T121)', () => {
  it('the four gauges zero-fill over the observed tenant set and `queue_pending` is unchanged', async () => {
    const statements = recordBroadcastsTx({
      tenantRows: [{ tenant_id: 'busy' }, { tenant_id: 'quiet' }],
      pendingRows: [{ tenant_id: 'busy', count: 4 }],
      eblastStageRows: [
        {
          tenant_id: 'busy',
          awaiting_count: 2,
          awaiting_oldest_age_seconds: 691_200,
          changes_requested_count: 1,
          marketing_turn_count: 5,
        },
      ],
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    // a tenant with rows gets its values
    expect(awaitingCountSpy).toHaveBeenCalledWith('busy', 2);
    expect(awaitingOldestAgeSpy).toHaveBeenCalledWith('busy', 691_200);
    expect(changesRequestedCountSpy).toHaveBeenCalledWith('busy', 1);
    expect(marketingTurnCountSpy).toHaveBeenCalledWith('busy', 5);

    // a tenant in the observed set with no new-stage rows reads 0 on all four,
    // never its last value (the C9 latch class)
    expect(awaitingCountSpy).toHaveBeenCalledWith('quiet', 0);
    expect(awaitingOldestAgeSpy).toHaveBeenCalledWith('quiet', 0);
    expect(changesRequestedCountSpy).toHaveBeenCalledWith('quiet', 0);
    expect(marketingTurnCountSpy).toHaveBeenCalledWith('quiet', 0);

    // queue_pending: same values, same statement — never widened to the new stages
    expect(queuePendingSpy).toHaveBeenCalledWith('busy', 4);
    expect(queuePendingSpy).toHaveBeenCalledWith('quiet', 0);
    const pendingSql = statements.filter((s) => /status::text IN \('submitted', 'approved'\)/.test(s));
    expect(pendingSql).toHaveLength(1);
    expect(pendingSql[0]).not.toMatch(/awaiting_member_approval|in_design|changes_requested|member_approved/);

    // the new statement runs inside the SAME broadcasts transaction and compares
    // `status::text` (a bare enum literal not yet in the pg enum would error)
    const stageSql = statements.filter((s) => /awaiting_member_approval/.test(s));
    expect(stageSql).toHaveLength(1);
    expect(stageSql[0]).toMatch(/status::text/);
    expect(stageSql[0]).not.toMatch(/status\s*(=|IN)\s*\(?'/);
    expect(dbTransactionMock).toHaveBeenCalledTimes(2);
  });

  it('a tenant present ONLY in the stage rows joins the observed set', async () => {
    recordBroadcastsTx({
      tenantRows: [],
      pendingRows: [],
      eblastStageRows: [
        { tenant_id: 'stage-only', awaiting_count: 0, awaiting_oldest_age_seconds: 0, changes_requested_count: 0, marketing_turn_count: 3 },
      ],
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest())).status).toBe(200);

    expect(marketingTurnCountSpy).toHaveBeenCalledWith('stage-only', 3);
    expect(queuePendingSpy).toHaveBeenCalledWith('stage-only', 0);
  });

  it('a negative age (DB/app clock skew) is clamped to 0', async () => {
    recordBroadcastsTx({
      tenantRows: [{ tenant_id: 'skewed' }],
      pendingRows: [],
      eblastStageRows: [
        { tenant_id: 'skewed', awaiting_count: 1, awaiting_oldest_age_seconds: -3, changes_requested_count: 0, marketing_turn_count: 0 },
      ],
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest())).status).toBe(200);

    expect(awaitingOldestAgeSpy).toHaveBeenCalledWith('skewed', 0);
  });
});
