/**
 * Round 3 review G5 — Contract test: GET /api/internal/metrics/broadcasts-gauges.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header                  → 401 unauthorized
 *   - wrong Bearer token                            → 401 unauthorized
 *   - production env without CRON_SECRET            → 401 unauthorized
 *   - valid bearer + DB query OK                    → 200 + summary shape
 *     (queuePending + stuckSending + dispatchRatio counters all emit
 *      via broadcastsMetrics)
 *   - valid bearer + DB transaction throws          → 500 query_failed
 *
 * Per-tenant gauge emission for `dispatch_failure_rate` is the
 * Round 3 G1+G5 observability fix surface — this test pins the
 * route's emit + summary contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbTransactionMock = vi.fn();
const queuePendingSpy = vi.fn();
const stuckSendingCountSpy = vi.fn();
const dispatchFailureRateSpy = vi.fn();
// Review 2026-09-07 (errors HIGH-4b) — the fifth family: approved rows more
// than 1 h past `scheduled_for`, the only signal for a schedule slipping tick
// after tick because the audience cannot be built.
const approvedOverdueCountSpy = vi.fn();
const audienceImportStuckCountSpy = vi.fn();
const forgetDispatchFailureRateSpy = vi.fn();
// /code-review 2026-09-07 (finding #6) — the sixth family, and the last one
// still latching: it was emitted straight from its GROUP BY rows.
const suppressionListSizeSpy = vi.fn();
// F114 T102 (research § V2) — the members gauges ride the SAME tick as a
// second `db.transaction` with its own try/catch: two spies for its two
// gauges, and the logger's error arm captured so the members-half failure
// can be asserted as logged-not-fatal.
const membersPendingCountSpy = vi.fn();
const membersOldestAgeSecondsSpy = vi.fn();
// SEC-5 — while the platform flag is OFF the two members series must go
// ABSENT, not stay at their last value: a retained queue nobody can decide
// would keep paging "> 14 d".
const membersForgetGaugesSpy = vi.fn();
const loggerErrorSpy = vi.fn();

const envMock = {
  isDevelopment: false,
  features: { memberChangeApproval: true },
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => loggerErrorSpy(...a), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    transaction: (...args: unknown[]) => dbTransactionMock(...args),
  },
}));
vi.mock('@/lib/cron-auth', () => ({
  verifyCronBearer: (header: string | null, expected: string) => {
    if (header === null) return false;
    if (!header.startsWith('Bearer ')) return false;
    return header.slice('Bearer '.length) === expected;
  },
}));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      queuePending: queuePendingSpy,
      stuckSendingCount: stuckSendingCountSpy,
      dispatchFailureRate: dispatchFailureRateSpy,
      forgetDispatchFailureRate: forgetDispatchFailureRateSpy,
      approvedOverdueCount: approvedOverdueCountSpy,
      audienceImportStuckCount: audienceImportStuckCountSpy,
      suppressionListSize: suppressionListSizeSpy,
    },
    membersMetrics: {
      ...actual.membersMetrics,
      changeRequests: {
        ...actual.membersMetrics.changeRequests,
        pendingCount: membersPendingCountSpy,
        oldestAgeSeconds: membersOldestAgeSecondsSpy,
        forgetGauges: membersForgetGaugesSpy,
      },
    },
  };
});

function makeRequest(auth?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers['authorization'] = auth;
  return new NextRequest(
    'http://localhost/api/internal/metrics/broadcasts-gauges',
    { method: 'GET', headers },
  );
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  envMock.isDevelopment = false;
  envMock.features.memberChangeApproval = true;
  dbTransactionMock.mockReset();
  queuePendingSpy.mockReset();
  stuckSendingCountSpy.mockReset();
  dispatchFailureRateSpy.mockReset();
  approvedOverdueCountSpy.mockReset();
  audienceImportStuckCountSpy.mockReset();
  forgetDispatchFailureRateSpy.mockReset();
  suppressionListSizeSpy.mockReset();
  membersPendingCountSpy.mockReset();
  membersOldestAgeSecondsSpy.mockReset();
  membersForgetGaugesSpy.mockReset();
  loggerErrorSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe('GET /api/internal/metrics/broadcasts-gauges — wire contract', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
    expect(queuePendingSpy).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('production env without CRON_SECRET configured → 401 unauthorized', async () => {
    delete process.env.CRON_SECRET;
    envMock.isDevelopment = false;
    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer anything'));
    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('valid bearer + tenants with traffic → 200 + emits every gauge family', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      pendingRows: [{ tenant_id: 't1', count: 12 }],
      stuckRows: [{ tenant_id: 't1', count: 2 }],
      approvedOverdueRows: [{ tenant_id: 't1', count: 1 }],
      suppressionRows: [{ tenant_id: 't1', count: 7 }],
      // tenant t1: 30% failure rate (3/10), tenant t2: 0% (0/5)
      dispatchRows: [
        { tenant_id: 't1', failed: 3, dispatched: 10 },
        { tenant_id: 't2', failed: 0, dispatched: 5 },
      ],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pendingTenantCount: number;
      stuckTenantCount: number;
      dispatchRatioTenantCount: number;
      pendingTotal: number;
      stuckTotal: number;
      dispatchRatioMaxBps: number;
      stuckHours: number;
      dispatchWindowHours: number;
    };

    expect(body.ok).toBe(true);
    expect(body.pendingTenantCount).toBe(1);
    expect(body.stuckTenantCount).toBe(1);
    expect(body.dispatchRatioTenantCount).toBe(2);
    expect(body.pendingTotal).toBe(12);
    expect(body.stuckTotal).toBe(2);
    // 30% = 3000 bps; t2 = 0 bps → max is 3000.
    expect(body.dispatchRatioMaxBps).toBe(3000);
    expect(body.stuckHours).toBe(24);
    expect(body.dispatchWindowHours).toBe(1);

    expect(queuePendingSpy).toHaveBeenCalledWith('t1', 12);
    expect(stuckSendingCountSpy).toHaveBeenCalledWith('t1', 2);
    expect(dispatchFailureRateSpy).toHaveBeenCalledWith('t1', 0.3);
    expect(dispatchFailureRateSpy).toHaveBeenCalledWith('t2', 0);
    expect(approvedOverdueCountSpy).toHaveBeenCalledWith('t1', 1);
    expect((body as unknown as { approvedOverdueTotal: number }).approvedOverdueTotal).toBe(1);
  });

  // Review 2026-09-07 round 2 (C9 — errors LOW + observability HIGH) — a
  // count gauge LATCHED: the GROUP BY emits no row for a tenant at zero and
  // `observeGauge` never forgets, so once `approved_overdue_count` read 1 it
  // kept reading 1 after the incident was resolved, until the lambda
  // recycled — and the new "≥ 1 sustained 30 min" rule became a latch, not a
  // level. Every tenant the tick scanned is observed, 0 included ("0 means 0").
  it('a tenant with broadcasts but no overdue / pending / stuck rows is observed at 0, not left at its last value', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      pendingRows: [{ tenant_id: 't2', count: 3 }],
      stuckRows: [],
      dispatchRows: [],
      suppressionRows: [],
      approvedOverdueRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    expect(approvedOverdueCountSpy).toHaveBeenCalledWith('t1', 0);
    expect(approvedOverdueCountSpy).toHaveBeenCalledWith('t2', 0);
    expect(stuckSendingCountSpy).toHaveBeenCalledWith('t1', 0);
    expect(stuckSendingCountSpy).toHaveBeenCalledWith('t2', 0);
    expect(queuePendingSpy).toHaveBeenCalledWith('t1', 0);
    expect(queuePendingSpy).toHaveBeenCalledWith('t2', 3);
  });

  // /code-review 2026-09-07 (finding #6) — and the C9 latch class ONE MORE
  // loop down. `suppression_list_size` was emitted straight from its GROUP BY
  // rows, so a tenant with no `marketing_unsubscribes` row never got a sample
  // and `observeGauge` re-reported its last size forever: clear the list and
  // the gauge still says 7. It is a COUNT, so unlike the ratio it zero-fills.
  it('a tenant with no suppression rows is observed at 0 — a cleared list does not keep reporting its old size', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
      suppressionRows: [{ tenant_id: 't1', count: 7 }],
      approvedOverdueRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    expect((await GET(makeRequest('Bearer test-cron-secret'))).status).toBe(200);

    expect(suppressionListSizeSpy).toHaveBeenCalledWith('t1', 7);
    expect(suppressionListSizeSpy).toHaveBeenCalledWith('t2', 0);
  });

  // A tenant can carry unsubscribes before it has ever sent a broadcast (a
  // contact-level opt-out recorded first), so the suppression keys join the
  // observed set rather than depending on it.
  it('a tenant present ONLY in the suppression rows is still observed', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [],
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
      suppressionRows: [{ tenant_id: 't-quiet', count: 4 }],
      approvedOverdueRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    expect((await GET(makeRequest('Bearer test-cron-secret'))).status).toBe(200);

    expect(suppressionListSizeSpy).toHaveBeenCalledWith('t-quiet', 4);
  });

  // Re-review 2026-09-07 (finding #2) — the C9 latch class, unclosed in the
  // SAME function: `dispatch_failure_rate`'s query has `HAVING dispatched > 0`,
  // so a tenant with no traffic in the rolling hour emits no row, and
  // `observeGauge` re-reports its last value at every scrape. A tenant whose
  // single send failed at 10:00 reads 1.0 forever and pages forever. A
  // fabricated 0 would be a different lie ("we dispatched and none failed"),
  // so the honest answer is ABSENCE — the `forgetAutoInvoiceGauges` pattern.
  it('a tenant with no dispatch traffic in the window has its failure-rate label FORGOTTEN, not re-reported and not zeroed', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      pendingRows: [],
      stuckRows: [],
      suppressionRows: [],
      approvedOverdueRows: [],
      // t1 dispatched this hour; t2 did not.
      dispatchRows: [{ tenant_id: 't1', failed: 1, dispatched: 4 }],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    expect(dispatchFailureRateSpy).toHaveBeenCalledWith('t1', 0.25);
    expect(dispatchFailureRateSpy).not.toHaveBeenCalledWith('t2', 0);
    expect(forgetDispatchFailureRateSpy).toHaveBeenCalledWith('t2');
    expect(forgetDispatchFailureRateSpy).not.toHaveBeenCalledWith('t1');
  });

  it('valid bearer + zero traffic → 200 + zero summary, no metrics emitted', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [],
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
      // 108 PR-D (staff review P4): the fourth gauge family.
      suppressionRows: [],
      approvedOverdueRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatchRatioMaxBps: number };
    expect(body.dispatchRatioMaxBps).toBe(0);
    expect(queuePendingSpy).not.toHaveBeenCalled();
    expect(stuckSendingCountSpy).not.toHaveBeenCalled();
    expect(dispatchFailureRateSpy).not.toHaveBeenCalled();
    expect(approvedOverdueCountSpy).not.toHaveBeenCalled();
  });

  it('valid bearer + DB transaction throws → 500 query_failed (no metrics emitted)', async () => {
    dbTransactionMock.mockImplementationOnce(async () => {
      throw new Error('Neon: connection terminated');
    });

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('query_failed');
    expect(queuePendingSpy).not.toHaveBeenCalled();
    expect(dispatchFailureRateSpy).not.toHaveBeenCalled();
    expect(approvedOverdueCountSpy).not.toHaveBeenCalled();
  });

  it('dev env without CRON_SECRET → request still allowed (smoke convenience)', async () => {
    delete process.env.CRON_SECRET;
    envMock.isDevelopment = true;
    dbTransactionMock.mockImplementationOnce(async () => ({
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
      // 108 PR-D (staff review P4): the fourth gauge family.
      suppressionRows: [],
      approvedOverdueRows: [],
    }));

    const { GET } = await import(
      '@/app/api/internal/metrics/broadcasts-gauges/route'
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });
  /**
   * T106 (108 US5, FR-044 f) — an audience IMPORT that never finished.
   *
   * The use case turns one terminal at 30 minutes, but only on a tick that
   * reaches that broadcast. This gauge is the independent signal: it counts
   * rows whose import was submitted, never completed, and is older than the
   * threshold, so a broadcast the cron has stopped visiting at all is still
   * visible.
   *
   * Alarm, not page — nothing is lost and the row is already terminal or about
   * to be; what an operator needs is to know Resend has stopped answering.
   */
  it('an import submitted but never completed past the threshold is counted, and zero-filled elsewhere', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 't1' }, { tenant_id: 't2' }],
      pendingRows: [],
      stuckRows: [],
      dispatchRows: [],
      suppressionRows: [],
      approvedOverdueRows: [],
      audienceImportStuckRows: [{ tenant_id: 't1', count: 2 }],
    }));

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    expect(audienceImportStuckCountSpy).toHaveBeenCalledWith('t1', 2);
    // Same latch class as C9: observeGauge re-reports its last value, so a
    // tenant that drops out of the GROUP BY would keep alarming after the
    // incident cleared.
    expect(audienceImportStuckCountSpy).toHaveBeenCalledWith('t2', 0);
    const body = (await res.json()) as { audienceImportStuckTotal: number };
    expect(body.audienceImportStuckTotal).toBe(2);
  });
});

/**
 * F114 T102 (US6; FR-033, FR-037; research R12 + § V2) — the members
 * change-request gauges ride this SAME tick (no new cron: `vercel.json` has
 * 37 of the Pro plan's 40 jobs) as a SECOND `db.transaction` with its own
 * statement timeout and its own try/catch, so a members-half failure can
 * never cost the broadcasts gauges and vice-versa. The tick mocks each
 * `db.transaction` call in order: first the broadcasts rows, then the
 * members rows.
 */
/** The text of a drizzle sql template — enough to assert WHICH table a statement reads. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => (typeof c === 'object' && c !== null && 'value' in c ? (c as { value: readonly string[] }).value.join('') : ' ? '))
    .join('');
}

/**
 * Run the REAL members transaction callback against a recording `tx` double,
 * so the assertions below can see WHICH statements the block issues — a mock
 * that only returns rows cannot tell a `tenant_member_settings` read from a
 * full `DISTINCT` scan of the request table (A4), nor prove that the pending
 * scan was skipped (SEC-5).
 */
function recordMembersTx(rows: { tenantRows?: readonly unknown[]; pendingRows?: readonly unknown[] }): string[] {
  const statements: string[] = [];
  dbTransactionMock.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      execute: async (q: unknown) => {
        const text = sqlText(q);
        statements.push(text);
        if (/FROM\s+tenant_member_settings/i.test(text)) return rows.tenantRows ?? [];
        if (/FROM\s+member_change_requests/i.test(text)) return rows.pendingRows ?? [];
        return [];
      },
    };
    return fn(tx);
  });
  return statements;
}

describe('GET /api/internal/metrics/broadcasts-gauges — members change-request gauges (F114 T102)', () => {
  const broadcastsQuiet = () => ({
    tenantRows: [],
    pendingRows: [],
    stuckRows: [],
    dispatchRows: [],
    suppressionRows: [],
    approvedOverdueRows: [],
    audienceImportStuckRows: [],
  });

  it('pending rows for two tenants → both gauges observed with the right numbers, totals in the body', async () => {
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 'swecham' }, { tenant_id: 'other' }],
      pendingRows: [
        { tenant_id: 'swecham', count: 3, oldest_age_seconds: 604_800 },
        { tenant_id: 'other', count: 1, oldest_age_seconds: 42 },
      ],
    }));

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(dbTransactionMock).toHaveBeenCalledTimes(2);

    expect(membersPendingCountSpy).toHaveBeenCalledWith('swecham', 3);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('swecham', 604_800);
    expect(membersPendingCountSpy).toHaveBeenCalledWith('other', 1);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('other', 42);
    const body = (await res.json()) as { membersPendingTotal: number; membersPendingTenantCount: number; membersOldestAgeSecondsMax: number; membersGaugesOk: boolean };
    expect(body.membersPendingTotal).toBe(4);
    expect(body.membersPendingTenantCount).toBe(2);
    expect(body.membersOldestAgeSecondsMax).toBe(604_800);
    expect(body.membersGaugesOk).toBe(true);
  });

  // The C9 latch class (see the broadcasts cases above): a tenant that had a
  // pending request last tick and none now emits no GROUP BY row, and
  // `observeGauge` would re-report the old count forever — a resolved queue
  // that still pages. Every tenant with ANY change-request row is observed;
  // 0 pending is reported as 0, and an absent oldest age as 0 ("0 means 0").
  it('a tenant with change-request rows but none pending is observed at 0 on both gauges', async () => {
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 'swecham' }, { tenant_id: 'drained' }],
      pendingRows: [{ tenant_id: 'swecham', count: 2, oldest_age_seconds: 100 }],
    }));

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest('Bearer test-cron-secret'))).status).toBe(200);

    expect(membersPendingCountSpy).toHaveBeenCalledWith('drained', 0);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('drained', 0);
    expect(membersPendingCountSpy).toHaveBeenCalledWith('swecham', 2);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('swecham', 100);
  });

  it('the members query throwing → the broadcasts gauges are still emitted, 200 still returned, the members error logged', async () => {
    dbTransactionMock.mockImplementationOnce(async () => ({
      ...broadcastsQuiet(),
      tenantRows: [{ tenant_id: 't1' }],
      pendingRows: [{ tenant_id: 't1', count: 5 }],
    }));
    dbTransactionMock.mockImplementationOnce(async () => {
      throw new Error('relation "member_change_requests" does not exist');
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    expect(queuePendingSpy).toHaveBeenCalledWith('t1', 5);
    expect(membersPendingCountSpy).not.toHaveBeenCalled();
    expect(membersOldestAgeSecondsSpy).not.toHaveBeenCalled();
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(String) }), 'cron.broadcasts_gauges.members_query_failed');
    const body = (await res.json()) as { ok: boolean; pendingTotal: number; membersGaugesOk: boolean };
    expect(body.ok).toBe(true);
    expect(body.pendingTotal).toBe(5);
    expect(body.membersGaugesOk).toBe(false);
  });

  // SEC-1 (PR-3 review) — the two halves are independent BOTH ways. The
  // broadcasts catch used to `return` the 500 before the members block ran, so
  // a broadcasts outage silently took the FR-037 age gauge with it — the one
  // signal whose alert doubles as the 30-day data-subject-request backstop.
  // The broadcasts fault is still a 500 (the tick did not do its whole job);
  // it is answered at the END, with `broadcastsGaugesOk: false`.
  it('the broadcasts query throwing still emits the members gauges, answers 500, and says broadcastsGaugesOk: false', async () => {
    dbTransactionMock.mockImplementationOnce(async () => {
      throw new Error('Neon: connection terminated');
    });
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 'swecham' }],
      pendingRows: [{ tenant_id: 'swecham', count: 2, oldest_age_seconds: 1_300_000 }],
    }));

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(500);
    expect(dbTransactionMock).toHaveBeenCalledTimes(2);

    expect(membersPendingCountSpy).toHaveBeenCalledWith('swecham', 2);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('swecham', 1_300_000);
    // no broadcasts sample can be invented from a transaction that threw
    expect(queuePendingSpy).not.toHaveBeenCalled();
    expect(dispatchFailureRateSpy).not.toHaveBeenCalled();

    const body = (await res.json()) as { error?: string; broadcastsGaugesOk: boolean; membersGaugesOk: boolean; membersPendingTotal: number };
    expect(body.error).toBe('query_failed');
    expect(body.broadcastsGaugesOk).toBe(false);
    expect(body.membersGaugesOk).toBe(true);
    expect(body.membersPendingTotal).toBe(2);
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(String) }), 'cron.broadcasts_gauges.query_failed');
  });

  it('a healthy tick says broadcastsGaugesOk: true', async () => {
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    dbTransactionMock.mockImplementationOnce(async () => ({ tenantRows: [], pendingRows: [] }));
    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect((await res.json()) as { broadcastsGaugesOk: boolean }).toMatchObject({ broadcastsGaugesOk: true });
  });

  // A4 (PR-3 review) — the zero-fill tenant set used to be `SELECT DISTINCT
  // tenant_id FROM member_change_requests`: an index-only scan of the WHOLE
  // request history, every 5 min, growing with retention rather than with the
  // number of tenants. The set is now every PROVISIONED tenant
  // (`tenant_member_settings`) union the pending GROUP BY keys — the union keeps
  // a tenant with pending rows but no settings row (a pre-0209 seed) observed.
  it('the tenant set comes from tenant_member_settings + the pending keys, never a DISTINCT scan of the request table', async () => {
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    const statements = recordMembersTx({
      tenantRows: [{ tenant_id: 'provisioned-quiet' }],
      pendingRows: [{ tenant_id: 'no-settings-row', count: 1, oldest_age_seconds: 10 }],
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    expect((await GET(makeRequest('Bearer test-cron-secret'))).status).toBe(200);

    const membersSql = statements.join(String.fromCharCode(10));
    expect(membersSql).toMatch(/FROM\s+tenant_member_settings/i);
    expect(membersSql).not.toMatch(/DISTINCT\s+tenant_id\s+FROM\s+member_change_requests/i);
    // the union, both directions
    expect(membersPendingCountSpy).toHaveBeenCalledWith('provisioned-quiet', 0);
    expect(membersOldestAgeSecondsSpy).toHaveBeenCalledWith('provisioned-quiet', 0);
    expect(membersPendingCountSpy).toHaveBeenCalledWith('no-settings-row', 1);
  });

  // SEC-5 (PR-3 review) — while `FEATURE_MEMBER_CHANGE_APPROVAL` is OFF the
  // routes 404 and nobody can decide a retained request, so an age gauge
  // ticking past 14 d would page an operator who has no action to take. The
  // pending scan is skipped and both series are FORGOTTEN (absence, not a
  // fabricated 0 — a 0 would assert "the queue is empty", which is a
  // different fact) so no value can latch across a flag flip.
  it('flag OFF: no pending scan, both series forgotten per tenant, membersGaugesSkipped flag_off', async () => {
    envMock.features.memberChangeApproval = false;
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    const statements = recordMembersTx({
      tenantRows: [{ tenant_id: 'swecham' }, { tenant_id: 'other' }],
      pendingRows: [{ tenant_id: 'swecham', count: 3, oldest_age_seconds: 1_300_000 }],
    });

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    expect(statements.join(String.fromCharCode(10))).not.toMatch(/FROM\s+member_change_requests/i);
    expect(membersPendingCountSpy).not.toHaveBeenCalled();
    expect(membersOldestAgeSecondsSpy).not.toHaveBeenCalled();
    expect(membersForgetGaugesSpy).toHaveBeenCalledWith('swecham');
    expect(membersForgetGaugesSpy).toHaveBeenCalledWith('other');

    const body = (await res.json()) as { membersGaugesSkipped: string | null; membersPendingTotal: number; membersGaugesOk: boolean };
    expect(body.membersGaugesSkipped).toBe('flag_off');
    expect(body.membersPendingTotal).toBe(0);
    expect(body.membersGaugesOk).toBe(true);
  });

  it('flag ON: nothing is forgotten and the body carries membersGaugesSkipped null', async () => {
    dbTransactionMock.mockImplementationOnce(async () => broadcastsQuiet());
    dbTransactionMock.mockImplementationOnce(async () => ({
      tenantRows: [{ tenant_id: 'swecham' }],
      pendingRows: [{ tenant_id: 'swecham', count: 1, oldest_age_seconds: 5 }],
    }));

    const { GET } = await import('@/app/api/internal/metrics/broadcasts-gauges/route');
    const res = await GET(makeRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(membersForgetGaugesSpy).not.toHaveBeenCalled();
    expect((await res.json()) as { membersGaugesSkipped: string | null }).toMatchObject({ membersGaugesSkipped: null });
  });
});
