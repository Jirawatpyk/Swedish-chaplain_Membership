/**
 * F9 US3 (verify-run D1) — `timelineList` filter-resolution unit tests.
 *
 * Pins the application-layer branches the integration suite doesn't exercise:
 *   - invalid `from` / `to` / `from > to` → `invalid_input` BEFORE the member
 *     probe + repo query (so a bad date never reaches the `::timestamptz` cast)
 *   - valid source / actorKind / date filters thread through to the repo as
 *     resolved `fromTs`/`toTs` (UTC ISO) + source + actorKind
 *   - member-role projection strips internal annotations (FR-017)
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { timelineList } from '@/modules/members/application/use-cases/timeline-list';
import type { TenantContext } from '@/modules/tenants';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';
import type {
  TimelinePort,
  TimelineFilter,
} from '@/modules/members/application/ports/timeline-port';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;
const META = { actorUserId: 'u1', actorRole: 'admin' as const, requestId: 'r1' };
const MEMBER = '00000000-0000-4000-8000-000000000001';

function makeDeps(events: unknown[] = []) {
  const captured: { filter?: TimelineFilter } = {};
  const memberRepo = {
    findById: vi.fn().mockResolvedValue(ok({})),
  } as unknown as MemberRepo;
  const timeline = {
    listByMember: vi.fn(async (_ctx: TenantContext, filter: TimelineFilter) => {
      captured.filter = filter;
      return ok({ events, nextCursor: null, total: events.length });
    }),
  } as unknown as TimelinePort;
  return { deps: { memberRepo, timeline }, captured, memberRepo, timeline };
}

describe('timelineList — filter resolution (D1)', () => {
  it('rejects a malformed `from` with invalid_input before any DB access', async () => {
    const { deps, memberRepo, timeline } = makeDeps();
    const r = await timelineList(
      { memberId: MEMBER, limit: 50, from: 'not-a-date' },
      META,
      CTX,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_input');
    expect(memberRepo.findById).not.toHaveBeenCalled();
    expect(timeline.listByMember).not.toHaveBeenCalled();
  });

  it('rejects a malformed `to` with invalid_input', async () => {
    const { deps } = makeDeps();
    const r = await timelineList(
      { memberId: MEMBER, limit: 50, to: 'garbage' },
      META,
      CTX,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_input');
  });

  it('rejects `from` after `to` with invalid_input', async () => {
    const { deps, timeline } = makeDeps();
    const r = await timelineList(
      {
        memberId: MEMBER,
        limit: 50,
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-05-01T00:00:00.000Z',
      },
      META,
      CTX,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_input');
    expect(timeline.listByMember).not.toHaveBeenCalled();
  });

  it('threads valid source / actorKind / date filters through to the repo', async () => {
    const { deps, captured } = makeDeps();
    const r = await timelineList(
      {
        memberId: MEMBER,
        limit: 25,
        source: 'invoice',
        actorKind: 'system',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-31T23:59:59.999Z',
      },
      META,
      CTX,
      deps,
    );
    expect(r.ok).toBe(true);
    expect(captured.filter).toMatchObject({
      memberId: MEMBER,
      limit: 25,
      source: 'invoice',
      actorKind: 'system',
      fromTs: '2026-05-01T00:00:00.000Z',
      toTs: '2026-05-31T23:59:59.999Z',
    });
  });

  it('member-role projection strips internal annotations (FR-017)', async () => {
    const { deps } = makeDeps([
      {
        id: 'a1',
        timestamp: new Date('2026-05-20T10:00:00Z'),
        source: 'audit' as const,
        eventType: 'member_plan_changed',
        actorKind: 'staff' as const,
        actorUserId: 'admin-1',
        actorDisplayName: 'Admin',
        payload: { member_id: MEMBER, override_reason_note: 'secret', new_status: 'active' },
      },
    ]);
    const r = await timelineList(
      { memberId: MEMBER, limit: 50 },
      { ...META, actorRole: 'member' },
      CTX,
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = r.value.events[0]!;
    expect(ev.payload).not.toHaveProperty('override_reason_note');
    expect(ev.payload).toMatchObject({ member_id: MEMBER, new_status: 'active' });
  });

  it('member-role redaction applies to NON-AUDIT rows too (R2-5)', async () => {
    // redactEvents runs across all sources — a non-audit row carrying a
    // sensitive key (`notes`) must be stripped for members.
    const { deps } = makeDeps([
      {
        id: 'inv-9',
        timestamp: new Date('2026-05-21T10:00:00Z'),
        source: 'invoice' as const,
        eventType: 'issued',
        actorKind: 'staff' as const,
        actorDisplayName: null,
        payload: { status: 'issued', notes: 'internal staff note', invoice_id: 'inv-9' },
      },
    ]);
    const r = await timelineList(
      { memberId: MEMBER, limit: 50 },
      { ...META, actorRole: 'member' },
      CTX,
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = r.value.events[0]!;
    expect(ev.payload).not.toHaveProperty('notes');
    expect(ev.payload).toMatchObject({ status: 'issued', invoice_id: 'inv-9' });
  });
});
