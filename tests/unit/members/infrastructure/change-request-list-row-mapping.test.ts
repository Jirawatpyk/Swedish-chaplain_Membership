/**
 * F114 Phase 10 (post-ship `/code-review`, 2026-09-16) — the repo's LIST
 * projection.
 *
 *   - T126: a `decided_by_user_id` whose `users` join found nothing must not
 *     be answered as a reviewer named `''` with `deactivated: false`. The
 *     fabricated pair reads as a real, active reviewer everywhere the shape
 *     travels (the queue page, the review page, the decide 409 body); the UI
 *     already falls back to `unknownReviewer` on an empty name, so the repo's
 *     job is to SAY SO in the log rather than invent the row silently.
 *   - T124: a row outside the Domain shape is SKIPPED from the page (logged +
 *     counted), never allowed to fail the whole list. The live half is in
 *     `tests/integration/members/change-requests-repo.test.ts`; this pins the
 *     projection itself, including that a non-row error still propagates.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loggerError = vi.fn();
const loggerWarn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: (...a: unknown[]) => loggerWarn(...a), info: vi.fn(), debug: vi.fn() },
}));
const rowInvalid = vi.fn();
vi.mock('@/lib/metrics', () => ({
  membersMetrics: { changeRequests: { rowInvalid: (...a: unknown[]) => rowInvalid(...a) } },
}));

import { asTenantContext } from '@/modules/tenants';
import { projectListRows, toListRow } from '@/modules/members/infrastructure/db/drizzle-change-request-repo';
import type { MemberChangeRequestFieldRow, MemberChangeRequestRow } from '@/modules/members/infrastructure/db/schema-change-requests';

const TENANT = asTenantContext('test-tenant');
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const REVIEWER_ID = '44444444-4444-4444-8444-444444444444';

function requestRow(over: Partial<MemberChangeRequestRow> = {}): MemberChangeRequestRow {
  return {
    id: REQUEST_ID,
    tenantId: 'test-tenant',
    memberId: MEMBER_ID,
    submittedByUserId: '55555555-5555-4555-8555-555555555555',
    submittedByContactId: '22222222-2222-4222-8222-222222222222',
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'decided',
    outcome: 'approved',
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date('2026-09-11T08:00:00Z'),
    staffNotifiedAt: new Date('2026-09-11T08:00:00Z'),
    decidedAt: new Date('2026-09-12T08:00:00Z'),
    decidedByUserId: REVIEWER_ID,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    createdAt: new Date('2026-09-11T08:00:00Z'),
    updatedAt: new Date('2026-09-12T08:00:00Z'),
    ...over,
  } as MemberChangeRequestRow;
}

function joined(over: Record<string, unknown> = {}) {
  return {
    request: requestRow(),
    companyName: 'Nordic Co',
    memberNumber: 42,
    memberStatus: 'active',
    submitterFirstName: 'Anna',
    submitterLastName: 'Svensson',
    decidedByName: 'Reviewer Rae',
    decidedByStatus: 'active',
    ...over,
  } as Parameters<typeof toListRow>[0];
}

function fieldRow(over: Partial<MemberChangeRequestFieldRow> = {}): MemberChangeRequestFieldRow {
  return {
    tenantId: 'test-tenant',
    requestId: REQUEST_ID,
    fieldKey: 'phone',
    target: 'contact',
    seenValue: '+66812345678',
    proposedValue: '+66899999999',
    affectsTaxDocuments: false,
    outcome: 'approved',
    appliedAt: new Date('2026-09-12T08:00:00Z'),
    ...over,
  } as MemberChangeRequestFieldRow;
}

beforeEach(() => vi.clearAllMocks());

describe('toListRow — the reviewer join (T126)', () => {
  it('a present join answers the reviewer and logs nothing', () => {
    const row = toListRow(joined(), [fieldRow()]);
    expect(row.decidedBy).toEqual({ displayName: 'Reviewer Rae', deactivated: false });
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('a MISSED join (decided_by_user_id set, no users row) is logged as M114.repo.reviewer_join_missed with ids only', () => {
    const row = toListRow(joined({ decidedByName: null, decidedByStatus: null }), [fieldRow()]);
    // the UI renders `displayName || unknownReviewer`, so the empty name still
    // reaches the fallback — what must not happen is a SILENT fabrication
    expect(row.decidedBy?.displayName).toBe('');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [payload] = loggerWarn.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      errorId: 'M114.repo.reviewer_join_missed',
      changeRequestId: REQUEST_ID,
      decidedByUserId: REVIEWER_ID,
    });
    // ids only — never the member's or the reviewer's name
    expect(JSON.stringify(payload)).not.toContain('Nordic Co');
    expect(JSON.stringify(payload)).not.toContain('Svensson');
  });

  it('a request with NO reviewer at all (pending) logs nothing', () => {
    const row = toListRow(joined({ request: requestRow({ state: 'pending', outcome: null, decidedAt: null, decidedByUserId: null }), decidedByName: null, decidedByStatus: null }), []);
    expect(row.decidedBy).toBeNull();
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});

describe('projectListRows — one corrupt row must not take the page down (T124)', () => {
  it('skips the corrupt row, logs M114.repo.row_invalid, counts it, and returns the rest', () => {
    const goodId = '66666666-6666-4666-8666-666666666666';
    const corrupt = joined({ request: requestRow({ id: REQUEST_ID }) });
    const good = joined({ request: requestRow({ id: goodId }) });
    const fields = new Map<string, MemberChangeRequestFieldRow[]>([
      // a `seen_value` that is a NUMBER — outside the Domain shape
      [REQUEST_ID, [fieldRow({ seenValue: 42 as unknown as string })]],
      [goodId, [fieldRow({ requestId: goodId })]],
    ]);
    const items = projectListRows(TENANT, [corrupt, good], fields);
    expect(items.map((i) => i.request.id)).toEqual([goodId]);
    expect(rowInvalid).toHaveBeenCalledWith('test-tenant');
    const invalidLog = loggerError.mock.calls.find(
      (c) => (c[0] as { errorId?: string }).errorId === 'M114.repo.row_invalid',
    );
    expect(invalidLog).toBeDefined();
    expect(invalidLog?.[0]).toMatchObject({ tenantId: 'test-tenant', changeRequestId: REQUEST_ID, memberId: MEMBER_ID });
  });

  it('a NON-row error still propagates (only the row-shape class is skipped)', () => {
    const boom = joined();
    const fields = new Map<string, MemberChangeRequestFieldRow[]>([
      [REQUEST_ID, [new Proxy(fieldRow(), { get: () => { throw new RangeError('not a row error'); } }) as MemberChangeRequestFieldRow]],
    ]);
    expect(() => projectListRows(TENANT, [boom], fields)).toThrow(RangeError);
    expect(rowInvalid).not.toHaveBeenCalled();
  });
});
