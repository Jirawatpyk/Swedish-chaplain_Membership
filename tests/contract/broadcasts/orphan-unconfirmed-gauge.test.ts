/**
 * Spec 140 s2c (DL5b, [A7]) — the `create_unconfirmed` gauge on the EXISTING
 * broadcasts half of GET /api/internal/metrics/broadcasts-gauges:
 *
 *   broadcasts_orphaned_resend_ids_unconfirmed{tenant}
 *
 * = the `create_unconfirmed` orphan rows created in the last
 * `ORPHAN_UNCONFIRMED_GAUGE_WINDOW_HOURS` (24 h), zero-filled over the observed
 * tenant set like its `audience_import_stuck_count` sibling, read inside the
 * same broadcasts transaction (the owner role, as every sibling). A tenant
 * present only in the orphan rows joins the observed set.
 *
 * The REAL broadcasts callback runs against a recording `tx` that answers by
 * SQL text (the eblast-gauges.test.ts shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbTransactionMock = vi.fn();
const unconfirmedSpy = vi.fn();
const unsettledSpy = vi.fn();
const unsettledAgeSpy = vi.fn();
const queuePendingSpy = vi.fn();

vi.mock('@/modules/broadcasts', async () => ({
  MARKETING_TURN_STATUSES: (await import('@/modules/broadcasts/domain/stage/whose-turn')).MARKETING_TURN_STATUSES,
  ORPHAN_UNCONFIRMED_GAUGE_WINDOW_HOURS: (await import('@/modules/broadcasts/domain/value-objects/orphaned-resend-id'))
    .ORPHAN_UNCONFIRMED_GAUGE_WINDOW_HOURS,
  ORPHAN_UNSETTLED_GAUGE_AGE_HOURS: (await import('@/modules/broadcasts/domain/value-objects/orphaned-resend-id'))
    .ORPHAN_UNSETTLED_GAUGE_AGE_HOURS,
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
      awaitingMemberApprovalCount: vi.fn(),
      awaitingMemberOldestAgeSeconds: vi.fn(),
      changesRequestedCount: vi.fn(),
      marketingTurnCount: vi.fn(),
      orphanedResendIdsUnconfirmed: unconfirmedSpy,
      orphanedResendIdsUnsettled: unsettledSpy,
      orphanedResendIdsUnsettledOldestAgeSeconds: unsettledAgeSpy,
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

/** The text of a drizzle sql template, with its bound params in order. */
function sqlOf(q: unknown): { text: string; params: unknown[] } {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  const text = chunks
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'value' in c) return (c as { value: readonly string[] }).value.join('');
      params.push(c);
      return ' ? ';
    })
    .join('');
  return { text, params };
}

/** One recorded statement. */
type Statement = { text: string; params: unknown[] };

/**
 * Spec 140 s2c review round 1 (code-review #10) — the transactions in order:
 * the broadcasts siblings, the members half, then each orphan gauge in its OWN
 * transaction and try (`unconfirmed`, then `unsettled`). `fail` makes that one
 * throw.
 */
function recordTicks(rows: {
  readonly tenantRows: readonly unknown[];
  readonly unconfirmedRows?: readonly unknown[];
  readonly unsettledRows?: readonly unknown[];
  readonly fail?: 'unconfirmed' | 'unsettled';
}): Statement[] {
  const statements: Statement[] = [];
  const recordingTx = (answer: (s: Statement) => unknown) => async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async (q: unknown) => {
        const st = sqlOf(q);
        statements.push(st);
        return answer(st);
      },
    });
  dbTransactionMock.mockImplementationOnce(
    recordingTx((st) => (/SELECT DISTINCT tenant_id FROM broadcasts/.test(st.text) ? rows.tenantRows : [])),
  );
  dbTransactionMock.mockImplementationOnce(async () => ({ tenantRows: [], pendingRows: [] }));
  for (const gauge of ['unconfirmed', 'unsettled'] as const) {
    dbTransactionMock.mockImplementationOnce(
      rows.fail === gauge
        ? async () => {
            throw new Error('57014 canceling statement due to statement timeout');
          }
        : recordingTx((st) => {
            if (/SET LOCAL/.test(st.text)) return [];
            return gauge === 'unconfirmed' ? (rows.unconfirmedRows ?? []) : (rows.unsettledRows ?? []);
          }),
    );
  }
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
  dbTransactionMock.mockReset();
  for (const m of [unconfirmedSpy, unsettledSpy, unsettledAgeSpy, queuePendingSpy]) m.mockReset();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/internal/metrics/broadcasts-gauges — the create_unconfirmed orphan gauge (spec 140 s2c)', () => {
  it('counts create_unconfirmed rows of the last 24 h per tenant, zero-filled; an orphan-only tenant joins the observed set', async () => {
    const statements = recordTicks({
      tenantRows: [{ tenant_id: 'busy' }, { tenant_id: 'quiet' }],
      unconfirmedRows: [
        { tenant_id: 'busy', count: 2 },
        { tenant_id: 'orphan-only', count: 1 },
      ],
    });
    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest())).status).toBe(200);

    expect(unconfirmedSpy).toHaveBeenCalledWith('busy', 2);
    expect(unconfirmedSpy).toHaveBeenCalledWith('quiet', 0);
    expect(unconfirmedSpy).toHaveBeenCalledWith('orphan-only', 1);

    const orphanSql = statements.filter((s) => /broadcast_orphaned_resend_ids/.test(s.text) && /create_unconfirmed/.test(s.text));
    expect(orphanSql).toHaveLength(1);
    expect(orphanSql[0]!.text).toMatch(/reason = 'create_unconfirmed'/);
    expect(orphanSql[0]!.text).toMatch(/GROUP BY tenant_id/);
    // The window is the named constant, bound, not a literal in the SQL.
    expect(orphanSql[0]!.params).toContain(24);
  });

  it('the unsettled gauge: rows unsettled with an id for more than 24 h, and the oldest age, zero-filled', async () => {
    const statements = recordTicks({
      tenantRows: [{ tenant_id: 'busy' }, { tenant_id: 'quiet' }],
      unsettledRows: [{ tenant_id: 'busy', count: 3, oldest_age_seconds: 200_000 }],
    });
    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest())).status).toBe(200);
    expect(unsettledSpy).toHaveBeenCalledWith('busy', 3);
    expect(unsettledSpy).toHaveBeenCalledWith('quiet', 0);
    expect(unsettledAgeSpy).toHaveBeenCalledWith('busy', 200_000);
    expect(unsettledAgeSpy).toHaveBeenCalledWith('quiet', 0);
    const sqlText = statements.find((s) => /settled_at IS NULL/.test(s.text));
    expect(sqlText?.text).toMatch(/resource_id IS NOT NULL/);
    expect(sqlText?.params).toContain(24);
  });

  it.each(['unconfirmed', 'unsettled'] as const)(
    'a failed %s gauge does not dark the other orphan gauge or the siblings; the tick answers 500',
    async (fail) => {
      recordTicks({
        tenantRows: [{ tenant_id: 'busy' }],
        unconfirmedRows: [{ tenant_id: 'busy', count: 1 }],
        unsettledRows: [{ tenant_id: 'busy', count: 1, oldest_age_seconds: 90_000 }],
        fail,
      });
      const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
      const res = await GET(makeRequest());
      expect(res.status).toBe(500);
      const body = (await res.json()) as { orphanGaugesOk: boolean; broadcastsGaugesOk: boolean };
      expect(body).toMatchObject({ orphanGaugesOk: false, broadcastsGaugesOk: true });
      expect(queuePendingSpy).toHaveBeenCalledWith('busy', 0);
      if (fail === 'unconfirmed') {
        expect(unconfirmedSpy).not.toHaveBeenCalled();
        expect(unsettledSpy).toHaveBeenCalledWith('busy', 1);
      } else {
        expect(unsettledSpy).not.toHaveBeenCalled();
        expect(unconfirmedSpy).toHaveBeenCalledWith('busy', 1);
      }
    },
  );
});
