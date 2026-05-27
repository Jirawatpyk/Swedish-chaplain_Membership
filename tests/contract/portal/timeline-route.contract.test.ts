/**
 * F9 US3 (review-run I3) — contract test for `GET /api/portal/timeline`.
 *
 * The member's own timeline load-more endpoint. The member is ALWAYS derived
 * from the session (`findByLinkedUserId`), never from the request — so a
 * member can never read another member's timeline (FR-017 own-history-only).
 * Also pins the C1 error-branching: an unlinked account → EMPTY, but a real
 * repo failure → 500 (never masked as "no activity").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireSessionMock = vi.fn();
const findByLinkedUserIdMock = vi.fn();
const timelineListMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  requireSession: (...a: unknown[]) => requireSessionMock(...a),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham' }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-portal-timeline-1' }));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: (...a: unknown[]) => findByLinkedUserIdMock(...a) },
    timeline: {},
  }),
}));
vi.mock('@/modules/members', () => ({
  timelineList: (...a: unknown[]) => timelineListMock(...a),
  TIMELINE_SOURCES: ['audit', 'invoice', 'payment', 'event', 'broadcast', 'renewal'],
  TIMELINE_ACTOR_KINDS: ['staff', 'member', 'system'],
}));

const MEMBER_SESSION = { user: { id: 'member-user-1', role: 'member' }, session: { id: 's1' } };
const OWN_MEMBER_ID = '00000000-0000-4000-8000-0000000000aa';

async function callRoute(qs: string): Promise<Response> {
  const { GET } = await import('@/app/api/portal/timeline/route');
  return GET(new NextRequest(`http://localhost:3100/api/portal/timeline${qs}`, { method: 'GET' }));
}

describe('GET /api/portal/timeline — route contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMock.mockResolvedValue(MEMBER_SESSION);
    findByLinkedUserIdMock.mockResolvedValue(ok({ memberId: OWN_MEMBER_ID }));
    timelineListMock.mockResolvedValue(ok({ events: [], nextCursor: null, total: 0 }));
  });
  afterEach(() => vi.resetModules());

  it('FR-017 — always queries the SESSION-derived member, never a URL-supplied id', async () => {
    // Even if the caller injects ?memberId=<someone-else>, the route must
    // ignore it and use the member resolved from the session.
    await callRoute('?memberId=11111111-1111-4111-8111-111111111111&limit=50');
    expect(timelineListMock).toHaveBeenCalledTimes(1);
    const input = timelineListMock.mock.calls[0]![0] as { memberId: string };
    const meta = timelineListMock.mock.calls[0]![1] as { actorRole: string };
    expect(input.memberId).toBe(OWN_MEMBER_ID);
    expect(input.memberId).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(meta.actorRole).toBe('member');
  });

  it('unlinked account (repo.not_found) → 200 EMPTY (not an error)', async () => {
    findByLinkedUserIdMock.mockResolvedValueOnce(err({ code: 'repo.not_found' }));
    const res = await callRoute('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(timelineListMock).not.toHaveBeenCalled();
  });

  it('C1 — member lookup repo failure → 500 (never masked as empty)', async () => {
    findByLinkedUserIdMock.mockResolvedValueOnce(err({ code: 'repo.unexpected', cause: new Error('db down') }));
    const res = await callRoute('');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal');
    expect(timelineListMock).not.toHaveBeenCalled();
  });

  it('malformed date filter → 400 validation_error', async () => {
    const res = await callRoute('?from=garbage');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
    expect(timelineListMock).not.toHaveBeenCalled();
  });

  it('happy path → 200 with serialized items + next_cursor + total', async () => {
    timelineListMock.mockResolvedValueOnce(
      ok({
        events: [
          {
            id: 'inv-1',
            timestamp: new Date('2026-05-20T10:00:00.000Z'),
            source: 'invoice',
            eventType: 'issued',
            actorKind: 'staff',
            actorDisplayName: null,
            payload: { status: 'issued' },
          },
        ],
        nextCursor: 'cur-1',
        total: 1,
      }),
    );
    const res = await callRoute('?source=invoice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ source: string; actor_user_id: string | null }>;
      next_cursor: string | null;
      total: number;
    };
    expect(body.items[0]!.source).toBe('invoice');
    // Non-audit row → actor_user_id is null (discriminated union).
    expect(body.items[0]!.actor_user_id).toBeNull();
    expect(body.next_cursor).toBe('cur-1');
    expect(body.total).toBe(1);
  });

  it('audit row → actor_user_id is populated (union audit branch, R2-9)', async () => {
    timelineListMock.mockResolvedValueOnce(
      ok({
        events: [
          {
            id: 'aud-1',
            timestamp: new Date('2026-05-20T10:00:00.000Z'),
            source: 'audit',
            eventType: 'member_self_updated',
            actorKind: 'member',
            actorUserId: 'member-user-1',
            actorDisplayName: 'Jane',
            payload: { member_id: OWN_MEMBER_ID },
          },
        ],
        nextCursor: null,
        total: 1,
      }),
    );
    const res = await callRoute('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ source: string; actor_user_id: string | null }>;
    };
    expect(body.items[0]!.source).toBe('audit');
    expect(body.items[0]!.actor_user_id).toBe('member-user-1');
  });
});
