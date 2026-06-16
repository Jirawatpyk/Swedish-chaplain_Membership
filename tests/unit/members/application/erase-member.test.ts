/**
 * Unit tests for `eraseMember` use case SKELETON (COMP-1 US1, Task 4).
 *
 * Scope: input validation, the durable `member_erasure_requested` emit, and
 * the atomic tx that scrubs members + contacts. The session/invitation cascade
 * (Task 5) and the post-commit F7/F8 cascades + `member_erased` (Task 6) are
 * NOT yet wired — those gain their own coverage when implemented.
 *
 * Uses port stubs + a mocked `runInTenant` (`@/lib/db`) that invokes the
 * supplied fn with an empty tx — the skeleton talks to ports only, never the
 * raw Drizzle chain, so a bare `{}` tx is sufficient. Live RLS + cascade
 * coverage lives in the integration suite added by later tasks.
 */
import { describe, expect, it, vi } from 'vitest';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { asMemberId } from '@/modules/members';
import { ok } from '@/lib/result';
import { buildEraseDeps } from './erase-member.fixtures';

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: never) => unknown) => fn({} as never),
}));

const META = { actorUserId: 'admin-1', requestId: 'req-1' };
const MEMBER_ID = asMemberId('m-1');
const MISSING_ID = asMemberId('missing');

describe('eraseMember — requested audit + atomic scrub', () => {
  it('rejects an unknown reason with invalid_body', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(MEMBER_ID, { reason: 'because' }, META, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });

  it('emits member_erasure_requested before the scrub, then scrubs members + contacts', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erasure_requested');
    expect(deps.memberRepo.scrubPiiInTx).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER_ID,
      expect.objectContaining({ erasedAt: expect.any(Date) }),
    );
    expect(deps.contactRepo.scrubPiiForMemberInTx).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER_ID,
      expect.objectContaining({ erasedAt: expect.any(Date) }),
    );
  });

  it('returns not_found when the member does not exist', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findErasedAtById = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as const,
    );
    deps.memberRepo.findByIdInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as const,
    );
    const res = await eraseMember(
      MISSING_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
  });

  // LOW (existence oracle / audit pollution): the durable
  // `member_erasure_requested` row must NOT be written for a bogus or
  // cross-tenant memberId. The pre-flight existence read short-circuits with
  // `not_found` BEFORE the requested-audit emit, so the append-only DPO log is
  // never polluted with a clock-start for a non-existent subject (and the audit
  // row can't act as a cross-tenant existence oracle).
  it('does NOT emit member_erasure_requested when the member does not exist', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findErasedAtById = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as never,
    );
    const res = await eraseMember(
      MISSING_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erasure_requested');
    // No destructive work either — short-circuit is before the scrub tx.
    expect(deps.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
  });

  // MEDIUM (M2 re-emit flood): the use-case is re-driven (idempotent scrub +
  // US2 reconciler). A re-run over an ALREADY-erased member (erased_at set) must
  // NOT re-emit `member_erasure_requested` — that would append a fresh
  // `requested` row and conceptually restart the Art.12 one-month clock on every
  // reconciler pass. It still completes the scrub + cascades and re-emits
  // `member_erased` (the completion proof) — the request was already logged on
  // the first run.
  it('does NOT re-emit member_erasure_requested when the member is already erased (re-drive)', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findErasedAtById = vi.fn(
      async () => ({ ok: true, value: { erasedAt: new Date('2026-06-15T00:00:00.000Z') } }) as never,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const requestedEmits = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'member_erasure_requested',
    );
    expect(requestedEmits).toHaveLength(0);
    // But it still completes (scrub idempotent + cascades) → member_erased.
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  it('returns not_found when scrubPiiInTx reports the member vanished mid-tx', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.scrubPiiInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as const,
    );
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
  });

  // Load-bearing invariant (design §6 step 1): the durable
  // `member_erasure_requested` emit MUST commit before any destructive work,
  // so a failed request-audit aborts the flow with NO scrub attempted. This
  // guards the Art. 12 clock-start ordering — without it a scrub could run
  // with no DPO record of the request.
  it('does NOT attempt any scrub when the requested-audit emit fails', async () => {
    const deps = buildEraseDeps();
    // First (and only) audit call in the skeleton is the durable
    // member_erasure_requested emit — force it to fail. The use-case only
    // inspects `.ok`; the error shape is the real `RepoError` union.
    deps.audit.recordInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.unexpected' } }) as never,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('server_error');
    // Invariant: no destructive work before a confirmed request record.
    expect(deps.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
    expect(deps.contactRepo.scrubPiiForMemberInTx).not.toHaveBeenCalled();
  });

  // Contacts-side atomicity (design §6 step 2): a contact-scrub failure throws
  // inside the atomic scrub tx, rolling it back, and maps to `server_error`.
  it('returns server_error when the contact scrub fails (scrub tx rolls back)', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.scrubPiiForMemberInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.unexpected' } }) as never,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('server_error');
  });

  it('revokes sessions + emits user_sessions_revoked for each linked user, then soft-consumes invitations', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1', 'u-1', 'u-2']);
    deps.sessions.revokeAllForInTx = vi.fn(async () => ok({ revokedCount: 2 }));

    const res = await eraseMember(asMemberId('m-1'), { reason: 'pdpa_deletion_request' }, META, deps);
    expect(res.ok).toBe(true);

    // deduped to 2 unique users → 2 revoke calls, 2 user_sessions_revoked audits
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledTimes(2);
    const sessionAudits = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'user_sessions_revoked',
    );
    expect(sessionAudits).toHaveLength(2);
    // invitations soft-consumed for the DEDUPED user set
    expect(deps.invitations.softConsumePendingForUsersInTx).toHaveBeenCalledWith(
      expect.anything(),
      ['u-1', 'u-2'],
      expect.any(Date),
    );
  });

  it('passes the erasure reason to both cascades and emits member_erased on full success', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(true);

    expect(deps.broadcastsCascade.cancelInFlightForMember).toHaveBeenCalledWith(
      deps.tenant,
      asMemberId('m-1'),
      expect.objectContaining({ cancellationReason: 'gdpr_erasure_request' }),
    );
    expect(deps.renewalsCascade.cancelInFlightForMember).toHaveBeenCalledWith(
      deps.tenant,
      asMemberId('m-1'),
      expect.objectContaining({ cancellationReason: 'gdpr_erasure_request' }),
    );
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  it('does NOT emit member_erased when a cascade fails (left for the reconciler)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsCascade.cancelInFlightForMember = vi.fn(
      async () => ({ outcome: 'cascade_failed' }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // Distinct from the prior case (a non-ok OUTCOME): here the cascade adapter
  // THROWS. The post-commit cascade try/catch must catch it, flip
  // allCascadesClean=false, and suppress member_erased — never let a best-effort
  // cascade throw escape and never report completed:true on an incomplete run.
  it('a cascade THROW (not just non-ok outcome) → completed:false + no member_erased', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsCascade.cancelInFlightForMember = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  // H2 (code-review HIGH): the renewals `cascade_partial_failure` outcome means
  // "a concurrent admin cancel won the race — the cycle reached terminal
  // `cancelled` by a different actor" (BENIGN — the cycle IS cancelled). It must
  // NOT block `member_erased`, otherwise the US2 reconciler re-runs forever and
  // the erasure is stuck "incomplete" even though everything is done. Mirrors
  // `archive-member.ts` which classifies the same outcome as a concurrent_skip
  // (warn, not fail).
  it('renewals cascade_partial_failure (concurrent cancel) does NOT block member_erased', async () => {
    const deps = buildEraseDeps();
    deps.renewalsCascade.cancelInFlightForMember = vi.fn(
      async () =>
        ({
          outcome: 'cascade_partial_failure',
          cancelledCount: 0,
          skippedConcurrentCount: 1,
        }) as const,
    );
    const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(true);
    const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).toContain('member_erased');
  });

  // H2 refinement (Important): the renewals adapter maps TWO distinct situations
  // to the SAME `cascade_partial_failure` outcome — (1) a genuine concurrent
  // cancel (`skippedConcurrentCount > 0`, cycle IS terminal → benign, prior
  // test) and (2) a generic infra failure / audit-emit failure inside the
  // per-cycle cancel tx (`skippedConcurrentCount === 0` → the cycle is STILL
  // in-flight). The over-broad H2 fix treated BOTH as clean, so `member_erased`
  // could be emitted while a cycle is genuinely still in-flight, and the US2
  // reconciler (which keys on member_erased) would never re-drive it. The
  // refined rule keys benign-ness on `skippedConcurrentCount > 0`; a generic
  // failure (count 0) must keep blocking member_erased, mirroring how the
  // broadcasts partial is handled.
  it('renewals cascade_partial_failure from a genuine infra failure (no concurrent skip) DOES block member_erased', async () => {
    const deps = buildEraseDeps();
    deps.renewalsCascade.cancelInFlightForMember = vi.fn(
      async () =>
        ({
          outcome: 'cascade_partial_failure',
          cancelledCount: 0,
          skippedConcurrentCount: 0,
        }) as const,
    );
    const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  // Counterpart to the renewals case: the broadcasts `cascade_partial_failure`
  // outcome means `unexpectedErrorCount > 0` — some broadcasts genuinely remain
  // in-flight (not a benign race). It MUST keep blocking `member_erased` so the
  // US2 reconciler retries the stuck rows. (Asymmetry is deliberate: the two
  // ports give the same outcome label different meanings — see the port JSDocs.)
  it('broadcasts cascade_partial_failure still blocks member_erased (genuinely stuck)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsCascade.cancelInFlightForMember = vi.fn(
      async () =>
        ({
          outcome: 'cascade_partial_failure',
          cancelledCount: 2,
          skippedConcurrentCount: 0,
          unexpectedErrorCount: 1,
        }) as const,
    );
    const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  // The member_erased emit happens AFTER every cascade reports clean — but it
  // can still fail. Its catch must flip completed back to false so the result
  // never claims completion without the durable proof record (the US2
  // reconciler re-drives + re-emits later).
  it('member_erased emit failure flips completed back to false', async () => {
    const deps = buildEraseDeps();
    // Cascades are clean, but the member_erased audit write fails. Fail ONLY the
    // member_erased recordInTx call; member_erasure_requested (and any session
    // audits) must still succeed or the flow short-circuits earlier.
    deps.audit.recordInTx = vi.fn(async (_tx: unknown, _ctx: unknown, ev: { type: string }) =>
      ev.type === 'member_erased'
        ? ({ ok: false, error: { code: 'repo.unexpected' } })
        : ok(undefined),
    ) as never;
    const res = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.completed).toBe(false);
  });

  // Idempotency / resumability contract (design §6). These pin the behavior the
  // reliability reviewer confirmed: the scrub is repeatable (stable sentinels),
  // the cascades are individually idempotent, and member_erased is emitted ONLY
  // on a fully-clean run — so a partial run is completed by a later call (or the
  // US2 reconciler) and an incomplete run is never marked done.
  it('is idempotent at the scrub layer — a second run scrubs again without error', async () => {
    const deps = buildEraseDeps();
    await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    const res2 = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(res2.ok).toBe(true);
    // The scrub ran on BOTH invocations — stable sentinels make it safe to repeat.
    expect(deps.memberRepo.scrubPiiInTx).toHaveBeenCalledTimes(2);
  });

  it('re-drives a previously-failed F7 cascade on re-run and emits member_erased exactly once', async () => {
    const deps = buildEraseDeps();
    // First run: F7 cascade fails → not complete, no member_erased.
    // Second run: F7 cascade clean → completes, member_erased emitted.
    deps.broadcastsCascade.cancelInFlightForMember = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'cascade_failed', cancelledCount: 0 })
      .mockResolvedValueOnce({ outcome: 'ok', cancelledCount: 0 });

    const r1 = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.completed).toBe(false);

    const r2 = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.completed).toBe(true);

    const erasedEmits = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'member_erased',
    );
    expect(erasedEmits).toHaveLength(1); // emitted only on the run that completed
  });
});
