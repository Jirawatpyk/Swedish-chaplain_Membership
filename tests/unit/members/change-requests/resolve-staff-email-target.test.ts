/**
 * F114 T120 (post-ship `/code-review` 2026-09-16, finding #1) — the
 * dispatcher's staff arm must never DROP the reviewer's email when a resubmit
 * coalesced.
 *
 * FR-011: a resubmit within 1 h inherits `staffNotifiedAt` and queues no
 * outbox row. The earlier request's row is then the ONLY email in flight, and
 * skipping it as `request_superseded` means nobody is told for an hour. The
 * arm follows the replace chain to the pending head and renders that (SC-013:
 * the link opens the current values) — but only when the head inherited this
 * row's stamp, which is precisely the coalesced case. A replacement past the
 * window has a row of its own; rendering it here would be a duplicate.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asMemberId, asContactId } from '@/modules/members';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { TenantId } from '@/modules/members/domain/member';
import { MAX_REPLACEMENT_HOPS, resolveStaffEmailTarget } from '@/modules/members/application/use-cases/change-requests/resolve-staff-email-target';

const NOTIFIED = new Date('2026-09-16T08:00:00Z');
const LATER = new Date('2026-09-16T09:05:00Z');
const R = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as ChangeRequestId;

function request(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: R(1),
    tenantId: 'test-tenant' as TenantId,
    memberId: asMemberId('11111111-1111-4111-8111-111111111111'),
    submittedByUserId: '55555555-5555-4555-8555-555555555555' as unknown as UserId,
    submittedByContactId: asContactId('22222222-2222-4222-8222-222222222222'),
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: NOTIFIED,
    staffNotifiedAt: NOTIFIED,
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [],
    ...over,
  } as ChangeRequest;
}

const replaced = (id: ChangeRequestId, by: ChangeRequestId, notifiedAt: Date = NOTIFIED) =>
  request({ id, state: 'withdrawn', withdrawnReason: 'replaced', withdrawnAt: LATER, replacedByRequestId: by, staffNotifiedAt: notifiedAt });

function loaderOf(...rows: ChangeRequest[]) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return vi.fn(async (id: ChangeRequestId) => {
    const row = byId.get(id as string);
    return row ? ok(row) : err({ code: 'repo.not_found' as const });
  });
}

describe('resolveStaffEmailTarget (T120)', () => {
  it('a still-pending request is rendered as itself and reads nothing', async () => {
    const load = loaderOf();
    const r = await resolveStaffEmailTarget(request(), load);
    expect(r).toEqual({ kind: 'render', request: expect.objectContaining({ id: R(1) }) });
    expect(load).not.toHaveBeenCalled();
  });

  it('COALESCED resubmit: the replacement INHERITED the stamp, so the queued row renders the replacement', async () => {
    const head = request({ id: R(2), staffNotifiedAt: NOTIFIED, submittedAt: LATER });
    const r = await resolveStaffEmailTarget(replaced(R(1), R(2)), loaderOf(head));
    expect(r).toEqual({ kind: 'render', request: head });
  });

  it('a CHAIN of coalesced resubmits is followed to the pending head', async () => {
    const head = request({ id: R(4), staffNotifiedAt: NOTIFIED });
    const r = await resolveStaffEmailTarget(replaced(R(1), R(2)), loaderOf(replaced(R(2), R(3)), replaced(R(3), R(4)), head));
    expect(r).toEqual({ kind: 'render', request: head });
  });

  it('NOT coalesced: a replacement past the 1 h window stamped its OWN time and queued its OWN row — this one stays superseded (no duplicate email)', async () => {
    const head = request({ id: R(2), staffNotifiedAt: LATER, submittedAt: LATER });
    const r = await resolveStaffEmailTarget(replaced(R(1), R(2)), loaderOf(head));
    expect(r).toEqual({ kind: 'superseded' });
  });

  it('withdrawn BY THE MEMBER stays superseded — there is nothing to review', async () => {
    const load = loaderOf();
    const r = await resolveStaffEmailTarget(request({ state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: LATER }), load);
    expect(r).toEqual({ kind: 'superseded' });
    expect(load).not.toHaveBeenCalled();
  });

  it('closed by an ERASURE stays superseded (FR-030 — the reviewer must not be handed a scrubbed request)', async () => {
    const r = await resolveStaffEmailTarget(request({ state: 'withdrawn', withdrawnReason: 'erasure', withdrawnAt: LATER }), loaderOf());
    expect(r).toEqual({ kind: 'superseded' });
  });

  it('already DECIDED stays superseded', async () => {
    const r = await resolveStaffEmailTarget(
      request({ state: 'decided', outcome: 'approved', decidedAt: LATER, decidedByUserId: 'u' as unknown as UserId }),
      loaderOf(),
    );
    expect(r).toEqual({ kind: 'superseded' });
  });

  it('a chain that reaches a DECIDED head stays superseded', async () => {
    const head = request({ id: R(3), state: 'decided', outcome: 'rejected', decisionReason: 'no', decidedAt: LATER, decidedByUserId: 'u' as unknown as UserId });
    const r = await resolveStaffEmailTarget(replaced(R(1), R(2)), loaderOf(replaced(R(2), R(3)), head));
    expect(r).toEqual({ kind: 'superseded' });
  });

  it('a hard-deleted successor is `gone` (permanent + audited), a repo FAULT is `fault` (stays on the retry ladder)', async () => {
    expect(await resolveStaffEmailTarget(replaced(R(1), R(2)), loaderOf())).toEqual({ kind: 'gone' });
    const faulty = vi.fn(async () => err({ code: 'repo.unexpected' as const, cause: new Error('boom') }));
    expect(await resolveStaffEmailTarget(replaced(R(1), R(2)), faulty)).toEqual({ kind: 'fault' });
  });

  it('a cyclic replace pointer terminates at the hop bound instead of looping the cron tick forever', async () => {
    const loop = vi.fn(async (id: ChangeRequestId) => ok(replaced(id, R(2))));
    const r = await resolveStaffEmailTarget(replaced(R(1), R(2)), loop);
    expect(r).toEqual({ kind: 'superseded' });
    expect(loop).toHaveBeenCalledTimes(MAX_REPLACEMENT_HOPS);
  });
});
