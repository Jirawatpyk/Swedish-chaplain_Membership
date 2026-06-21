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
import {
  eraseMember,
  type EraseMemberInput,
} from '@/modules/members/application/use-cases/erase-member';
import { asMemberId } from '@/modules/members';
import { ok } from '@/lib/result';
import type { MemberErasureReason } from '@/modules/members/application/ports/broadcasts-content-scrub-port';
import { buildEraseDeps } from './erase-member.fixtures';

// S2 type-design (US2b): structural coupling of the cross-module
// `MemberErasureReason` port enum to the erasure use-case's input. The port
// keeps the union HAND-DECLARED (deriving would invert the port→use-case
// dependency direction), so this bidirectional `extends` assertion is the
// compile-time guard that fails the build the moment the two drift apart.
// Equal sets ⇔ each `extends` the other.
type _PortReasonIsExactInputReason = MemberErasureReason extends EraseMemberInput['reason']
  ? EraseMemberInput['reason'] extends MemberErasureReason
    ? true
    : never
  : never;
const _assertPortReasonMatchesInput: _PortReasonIsExactInputReason = true;
void _assertPortReasonMatchesInput;

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

  // L4 (DPO-log honesty): on a re-drive that COMPLETES the erasure (first pass
  // scrubbed + revoked sessions/invitations but a cascade failed → no
  // member_erased; this later call finishes it), the linked-user read returns []
  // (the first pass already stamped contacts.removed_at), so this pass's
  // sessions_revoked_total / invitations_revoked_count are 0/0. A DPO reading
  // the final member_erased would wrongly conclude no sessions were terminated.
  // The `re_drive` flag (= the M2 `alreadyErased` pre-flight) makes the 0/0
  // honest: a reader sees re_drive:true and knows the authoritative revocation
  // record is the user_sessions_revoked rows from the FIRST pass.
  it('member_erased payload carries re_drive:true on a re-drive completion', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findErasedAtById = vi.fn(
      async () =>
        ({ ok: true, value: { erasedAt: new Date('2026-06-15T00:00:00.000Z') } }) as never,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const erasedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_erased',
    );
    const payload = (erasedCall?.[2] as { payload: { re_drive: boolean } })
      ?.payload;
    expect(payload.re_drive).toBe(true);
  });

  // Counterpart: a FIRST-pass completion (member not yet erased) must report
  // re_drive:false — the 0/0-when-already-revoked caveat does not apply because
  // this pass IS the pass that revoked them (the counts are authoritative here).
  it('member_erased payload carries re_drive:false on a first-pass completion', async () => {
    const deps = buildEraseDeps();
    // fixture default: findErasedAtById → erasedAt:null (first request).
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const erasedCall = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_erased',
    );
    const payload = (erasedCall?.[2] as { payload: { re_drive: boolean } })
      ?.payload;
    expect(payload.re_drive).toBe(false);
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);

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
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  // US3-C: the post-commit sub-processor cascade is NON-BLOCKING. If its OWN
  // audit emit (`subprocessor_erasure_propagated`) fails, member_erased must
  // STILL be emitted — the erasure is authoritative, the metric already fired,
  // and the DPO runbook owns the residual. Unlike the F1/F6/F7/F8 cascades, a
  // subprocessor failure NEVER flips allCascadesClean. This defensive branch is
  // hard to force in the live-Neon suite; pin it at the unit level.
  it('a subprocessor audit-emit failure is NON-BLOCKING — member_erased still emitted (US3-C)', async () => {
    const deps = buildEraseDeps();
    // Member received an audience-bearing broadcast → one pair to propagate, so
    // the subprocessor cascade does real work + attempts its audit emit.
    deps.broadcastsAudienceDerivation.listMemberAudienceContactsInTx = vi.fn(
      async () => [{ audienceId: 'aud_1', email: 'a@x.io' }],
    );
    // propagate succeeds (default 'ok'); fail ONLY the subprocessor audit emit
    // (a DB blip) — the member_erasure_requested + member_erased emits must still
    // succeed. A throw exercises the cascade's audit-emit catch.
    deps.audit.recordInTx = vi.fn(
      async (_tx: unknown, _ctx: unknown, event: { type: string }) => {
        if (event.type === 'subprocessor_erasure_propagated') {
          throw new Error('audit transport down');
        }
        return ok(undefined);
      },
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true); // NON-BLOCKING
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('subprocessor_erasure_propagated'); // emit attempted
    expect(types).toContain('member_erased'); // and member_erased still went through
    expect(deps.subprocessorErasure.propagate).toHaveBeenCalledWith(
      expect.objectContaining({
        audienceContacts: [{ audienceId: 'aud_1', email: 'a@x.io' }],
      }),
    );
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
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
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
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
    if (r1.ok) expect(r1.value.cascadesComplete).toBe(false);

    const r2 = await eraseMember(asMemberId('m-1'), { reason: 'gdpr_erasure_request' }, META, deps);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.cascadesComplete).toBe(true);

    const erasedEmits = deps.audit.recordInTx.mock.calls.filter(
      (c) => (c[2] as { type: string }).type === 'member_erased',
    );
    expect(erasedEmits).toHaveLength(1); // emitted only on the run that completed
  });

  // ---------------------------------------------------------------------------
  // Throw-path branch coverage (speckit-review Important #1). The arms below
  // are the error/throw branches that GATE the `member_erased` completion proof
  // on this GDPR PII surface. Each maps to one uncovered branch in the
  // pre-flight read, the scrub tx, the linked-user cascade, and the post-commit
  // cascades — so a regression that swallows a repo/cascade failure (and emits
  // `member_erased` over an incomplete erasure) now fails the suite.
  // ---------------------------------------------------------------------------

  // Pre-flight read returns a NON-not_found repo error (timeout / connection
  // blip). Distinct from the `not_found` short-circuit (which returns not_found
  // emitting no audit): an unexpected read failure must map to `server_error`
  // and STILL emit no `member_erasure_requested` — the durable clock-start must
  // not be written when we couldn't even confirm the subject exists.
  it('returns server_error when the pre-flight read fails with a non-not_found error', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findErasedAtById = vi.fn(
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
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erasure_requested');
    expect(deps.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
  });

  // findByIdInTx (the FOR UPDATE row lock inside the scrub tx) returns a
  // NON-not_found error. Distinct from the not_found arm (which maps to
  // not_found via EraseNotFoundError): a generic lookup failure throws
  // `lookup_failed:<code>`, rolls the scrub tx back, and maps to server_error.
  it('returns server_error when findByIdInTx fails with a non-not_found error', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.findByIdInTx = vi.fn(
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
    // The scrub never ran — the row-lock lookup failed first.
    expect(deps.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
  });

  // TOCTOU: the member passes the pre-flight read (exists, not erased) but
  // findByIdInTx (the FOR UPDATE lock) reports not_found — a concurrent
  // hard-delete won the race between the pre-flight and the scrub tx. The
  // not_found arm of findByIdInTx throws EraseNotFoundError → not_found (NOT
  // server_error). Distinct from the prior case where findByIdInTx fails with a
  // generic error; here the pre-flight succeeds so we reach the tx's row lock.
  it('returns not_found when findByIdInTx reports the member vanished after pre-flight (TOCTOU)', async () => {
    const deps = buildEraseDeps();
    // pre-flight default: member exists + not erased. Only the in-tx lock 404s.
    deps.memberRepo.findByIdInTx = vi.fn(
      async () => ({ ok: false, error: { code: 'repo.not_found' } }) as never,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('not_found');
    // Pre-flight succeeded → the durable requested-audit WAS emitted (clock
    // started) before the TOCTOU vanish; the scrub then aborted cleanly.
    expect(deps.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
  });

  // scrubPiiInTx returns a NON-not_found error. Distinct from the not_found arm
  // (member vanished mid-tx → not_found): a generic scrub failure throws
  // `member_scrub_failed:<code>`, rolls the tx back, and maps to server_error.
  it('returns server_error when scrubPiiInTx fails with a non-not_found error', async () => {
    const deps = buildEraseDeps();
    deps.memberRepo.scrubPiiInTx = vi.fn(
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

  // Session revocation for a linked user returns not-ok → throws
  // `session_revoke_failed:<code>`, rolling the scrub tx back (server_error).
  // The Art.17 cascade must not partially succeed: a failed revoke aborts the
  // whole erasure so the US2 reconciler re-drives it (member_erased never set).
  it('returns server_error when a linked-user session revoke fails', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    deps.sessions.revokeAllForInTx = vi.fn(
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
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // The `user_sessions_revoked` audit emit (after a successful revoke) returns
  // not-ok → throws 'audit_failed', rolling the scrub tx back (server_error).
  // Fail ONLY the session audit so it's distinguishable from the durable
  // member_erasure_requested emit (which must still succeed to reach the loop).
  it('returns server_error when the user_sessions_revoked audit emit fails', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    deps.sessions.revokeAllForInTx = vi.fn(async () => ok({ revokedCount: 1 }));
    deps.audit.recordInTx = vi.fn(
      async (_tx: unknown, _ctx: unknown, ev: { type: string }) =>
        ev.type === 'user_sessions_revoked'
          ? ({ ok: false, error: { code: 'repo.unexpected' } })
          : ok(undefined),
    ) as never;
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('server_error');
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // Renewals cascade returns a bare `cascade_failed` outcome (NOT
  // cascade_partial_failure / ok). The `r.outcome !== 'ok'` else-if arm flips
  // allCascadesClean=false so member_erased is withheld — the broadcasts
  // cascade succeeded but the renewals one is genuinely incomplete, left for
  // the US2 reconciler.
  it('renewals bare cascade_failed blocks member_erased (cascadesComplete:false)', async () => {
    const deps = buildEraseDeps();
    deps.renewalsCascade.cancelInFlightForMember = vi.fn(
      async () => ({ outcome: 'cascade_failed', cancelledCount: 0 }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // Renewals cascade THROWS (vs the non-ok outcome above). The post-commit
  // try/catch must catch it, flip allCascadesClean=false, and withhold
  // member_erased — never let a best-effort cascade throw escape. Throws an
  // Error so the `cascadeErr instanceof Error` true-arm of the catch's
  // String(cascadeErr) ternary is exercised.
  it('renewals cascade THROW → cascadesComplete:false + no member_erased', async () => {
    const deps = buildEraseDeps();
    deps.renewalsCascade.cancelInFlightForMember = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // Defensive ternary arm: a cascade can throw a NON-Error value (e.g. a bare
  // string). The catch logs `String(cascadeErr)` (the false arm of the
  // `cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr)`
  // ternary). Thrown from BOTH cascades so the false arm of each catch's
  // ternary is covered; still must withhold member_erased.
  it('a cascade throwing a NON-Error value is handled (String(cascadeErr) arm)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsCascade.cancelInFlightForMember = vi.fn(async () => {
      throw 'broadcasts-string-failure';
    });
    deps.renewalsCascade.cancelInFlightForMember = vi.fn(async () => {
      throw 'renewals-string-failure';
    });
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // ---------------------------------------------------------------------------
  // COMP-1 US2a — F1 linked-user erasure cascade (Task 6). The keystone that
  // closes the US1→US2 residual: an erased member's F1 login email must no
  // longer resolve at sign-in. The cascade runs POST-COMMIT (per linked-user,
  // each in its own owner-role tx via the adapter), driven by the linked-user
  // snapshot captured INSIDE the scrub tx (Bug I-1: a post-scrub re-read would
  // be [] because the contacts now carry removed_at). A failure flips
  // allCascadesClean=false and withholds member_erased so the US2d reconciler
  // re-drives — same gating the F7/F8 cascades use.
  // ---------------------------------------------------------------------------

  it('erases each UNIQUE linked F1 user post-commit and stays clean on success', async () => {
    const deps = buildEraseDeps();
    // The F1 cascade work-list reads from the UNFILTERED method (re-drive-safe).
    // A duplicate id is deduped so each unique login is erased exactly once.
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(
      async () => ['u-1', 'u-1', 'u-2'],
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);

    // Deduped to 2 unique users → 2 eraseUser calls, each carrying the meta
    // actorUserId + requestId verbatim (the adapter substitutes a sentinel for
    // a null requestId; here it's the non-null 'req-1').
    expect(deps.userErasure.eraseUser).toHaveBeenCalledTimes(2);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-1', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-2', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  it('erased:false (login already gone) is a SUCCESS — does NOT block member_erased', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    // The auth use-case found no row to anonymise (hard-deleted / never
    // existed) — the erasure goal already holds, so this is ok({erased:false}).
    deps.userErasure.eraseUser = vi.fn(async () => ok({ erased: false }));
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  it('a failing F1 user-erasure blocks member_erased but still erases the OTHER linked users (best-effort)', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(
      async () => ['u-1', 'u-2'],
    );
    // u-1 fails (typed err — never throws); u-2 must STILL be erased (the loop
    // is best-effort, one user's failure does not abort the rest).
    deps.userErasure.eraseUser = vi.fn(async (userId: string) =>
      userId === 'u-1'
        ? ({ ok: false, error: { code: 'erase-user-failed' } } as const)
        : ok({ erased: true }),
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    // One linked-user failed → not clean → member_erased withheld (reconciler
    // re-drives).
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    // Best-effort: BOTH users were attempted, not just up to the first failure.
    expect(deps.userErasure.eraseUser).toHaveBeenCalledTimes(2);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-2', expect.anything());
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // The adapter is documented as never-throws, but the cascade loop guards a
  // throw defensively (mirrors the F7/F8 cascade try/catch) so a pathological
  // adapter cannot abort the remaining users or escape the use-case. A throw
  // flips allCascadesClean=false and withholds member_erased.
  it('a THROWING F1 user-erasure is caught → not clean, others still attempted, no member_erased', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(
      async () => ['u-1', 'u-2'],
    );
    deps.userErasure.eraseUser = vi.fn(async (userId: string) => {
      if (userId === 'u-1') throw new Error('boom');
      return ok({ erased: true });
    });
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    // u-1 threw but u-2 was still attempted (per-user try/catch, not an
    // abort-the-loop catch).
    expect(deps.userErasure.eraseUser).toHaveBeenCalledTimes(2);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-2', expect.anything());
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  it('a member with ZERO linked users makes no eraseUser calls and stays clean (no regression)', async () => {
    const deps = buildEraseDeps();
    // fixture default: listAllLinkedUserIdsForMemberInTx → [] (no F1 work-list).
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);
    expect(deps.userErasure.eraseUser).not.toHaveBeenCalled();
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  // Bug I-1 regression guard (read-before-scrub) — re-targeted onto the
  // UNFILTERED F1 work-list method. The F1 linked-login work-list MUST be
  // captured from the read INSIDE the scrub tx, NOT re-read in the post-commit
  // section. The work-list now reads `listAllLinkedUserIdsForMemberInTx`
  // (unfiltered by removed_at — re-drive-stable), so even an in-tx read AFTER
  // the scrub stamps removed_at still discovers the linked logins. We pin the
  // once-only intent: the cascade issues EXACTLY ONE work-list read (the in-tx
  // snapshot), never a second post-commit re-read. `.mockResolvedValue([])`
  // after the first call would make a stray second read erase nobody — the
  // `toHaveBeenCalledTimes(1)` assertion catches that regression.
  it('erases the linked users from the single in-tx unfiltered work-list read, no post-commit re-read (Bug I-1 guard)', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi
      .fn()
      .mockResolvedValueOnce(['u-1', 'u-2']) // the in-tx work-list read
      .mockResolvedValue([]); // a stray later re-read would strand the logins
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);
    // The cascade used the in-tx work-list — both logins erased.
    expect(deps.userErasure.eraseUser).toHaveBeenCalledTimes(2);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-1', expect.anything());
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-2', expect.anything());
    // And the use-case did NOT issue a second work-list read in the
    // post-commit section (only the one in-tx read).
    expect(
      deps.contactRepo.listAllLinkedUserIdsForMemberInTx,
    ).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // COMP-1 US2a — Critical credential-survival guard (Task 6 security review).
  // A re-drive MUST re-attempt a login that FAILED to erase on a prior pass.
  //
  // The bug (pre-fix): the F1 work-list was sourced from the FILTERED
  // `listLinkedUserIdsForMemberInTx` (removed_at IS NULL). On pass 1 the
  // contacts scrub stamps removed_at, so a re-drive's in-tx read returned [] →
  // the F1 loop was a NO-OP → with F7/F8 idempotently clean, `member_erased`
  // was emitted even though the previously-failed login was NEVER re-attempted
  // → the US2d reconciler (keyed on member_erased) stopped → the erased member
  // kept a working credential forever (Art.17 credential survival).
  //
  // The fix: source the work-list from the UNFILTERED
  // `listAllLinkedUserIdsForMemberInTx` — the linked_user_id survives on the
  // removed contact row, so on a re-drive the work-list re-includes every
  // linked login (real method is re-drive-stable → returns the SAME ids on
  // BOTH passes). We model that here: the unfiltered method returns
  // [u-1,u-2,u-3] on both passes; eraseUser fails for u-3 on pass 1, succeeds
  // on pass 2.
  //
  // Against the OLD filtered read the pass-2 work-list would be [] → u-3 never
  // re-attempted → this test is RED. With the unfiltered work-list it passes.
  it('re-drive re-attempts a login that FAILED on the prior pass, then emits member_erased (Critical, US2a)', async () => {
    const deps = buildEraseDeps();
    // Re-drive-stable: the unfiltered work-list survives the contacts scrub, so
    // it returns the SAME three linked logins on EVERY pass (mirrors the live
    // adapter — linked_user_id is preserved on the removed contact row).
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(
      async () => ['u-1', 'u-2', 'u-3'],
    );

    // u-3 fails on pass 1 (transient Neon blip), succeeds on every later call.
    let u3Attempts = 0;
    deps.userErasure.eraseUser = vi.fn(async (userId: string) => {
      if (userId === 'u-3') {
        u3Attempts += 1;
        if (u3Attempts === 1)
          return { ok: false, error: { code: 'erase-user-failed' } } as const;
      }
      return ok({ erased: true });
    });

    // Pass 1 — u-3 fails → not clean → member_erased WITHHELD (correct).
    const pass1 = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(pass1.ok).toBe(true);
    if (pass1.ok) expect(pass1.value.cascadesComplete).toBe(false);
    const pass1Types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(pass1Types).not.toContain('member_erased');
    // All three were attempted on pass 1 (best-effort loop).
    expect(deps.userErasure.eraseUser).toHaveBeenCalledTimes(3);

    deps.audit.recordInTx.mockClear();

    // Pass 2 (US2d reconciler re-drive) — the work-list STILL includes u-3
    // (unfiltered read survives the removed_at scrub), so u-3 is RE-ATTEMPTED.
    const pass2 = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(pass2.ok).toBe(true);
    // u-3 was re-attempted on pass 2 (proves the credential is not stranded).
    expect(u3Attempts).toBe(2);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-3', expect.anything());
    // Now every login is erased → clean → member_erased finally emitted.
    if (pass2.ok) expect(pass2.value.cascadesComplete).toBe(true);
    const pass2Types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(pass2Types).toContain('member_erased');
  });

  // ---------------------------------------------------------------------------
  // COMP-1 US2b — F7 broadcast content + deliveries scrub cascade (Task 5).
  // Redacts the PII a member authored into / received in F7 broadcasts: scrubs
  // every broadcast the member ORIGINATED and tombstones every delivery the
  // member RECEIVED. Runs POST-COMMIT, after the F1 user cascade and BEFORE the
  // member_erased completion proof. The F7 scrub use-case runs its OWN atomic
  // tx (content + deliveries + audit co-commit), so this cascade is re-drive-
  // safe by construction. A non-ok outcome / throw flips allCascadesClean=false
  // and withholds member_erased so the US2d reconciler re-drives — the SAME
  // gating the F1/F7/F8 cascades use.
  // ---------------------------------------------------------------------------

  it('scrubs F7 content for the member post-commit (tenant, memberId, meta) and stays clean on success', async () => {
    const deps = buildEraseDeps();
    // The member has two LIVE contacts + one linked-login email. COMP-1 FIX-3 —
    // the delivery tombstone + audience + custom-recipient redaction key on
    // listTombstoneEmailsForMemberInTx (all contact emails MINUS peer-live-
    // claimed; the login axis is still dropped — deliveries are only addressed
    // to contact emails). The live-only set now feeds only the outbox cancel;
    // the content scrub is keyed on memberId and does not see the email set.
    deps.contactRepo.listLiveEmailsForMemberInTx = vi.fn(async () => [
      'contact-a@example.com',
      'contact-b@example.com',
    ]);
    deps.contactRepo.listTombstoneEmailsForMemberInTx = vi.fn(async () => [
      'contact-a@example.com',
      'contact-b@example.com',
    ]);
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    deps.userEmails.listEmailsForUsersInTx = vi.fn(async () =>
      ok(['login@example.com']),
    );
    // The atomic in-tx delivery tombstone reports 3 rows — threaded into the
    // post-commit content-scrub meta so the single audit records both axes.
    deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx = vi.fn(
      async () => ({ tombstonedCount: 3 }),
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);

    // The delivery tombstone ran INSIDE the atomic scrub tx, keyed on the
    // unambiguous all-contact redaction set (FIX-3; login axis dropped). Args:
    // (tx, tenantSlug, recipientEmails).
    expect(
      deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx,
    ).toHaveBeenCalledTimes(1);
    const [, tombstoneTenantSlug, tombstoneEmails] =
      deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx.mock.calls[0]!;
    expect(tombstoneTenantSlug).toBe('t-1');
    // The all-contact redaction set (FIX-3) — NO linked-login email.
    expect([...tombstoneEmails].sort()).toEqual([
      'contact-a@example.com',
      'contact-b@example.com',
    ]);

    // Exactly one content-scrub call, carrying the tenant, member id, and the
    // meta the F7 audit needs — actorUserId → initiatedByUserId, requestId,
    // the erasure legal basis threaded straight through (no cast), and the
    // delivery-tombstone count from the atomic step (so the single audit
    // records both axes).
    expect(deps.broadcastsContentScrub.scrubContentForMember).toHaveBeenCalledTimes(1);
    const [scrubTenant, scrubMemberId, scrubMeta] =
      deps.broadcastsContentScrub.scrubContentForMember.mock.calls[0]!;
    expect(scrubTenant).toBe(deps.tenant);
    expect(scrubMemberId).toBe(asMemberId('m-1'));
    expect(scrubMeta).toMatchObject({
      initiatedByUserId: 'admin-1',
      requestId: 'req-1',
      reason: 'gdpr_erasure_request',
      tombstonedCount: 3,
    });
    // The content scrub no longer receives an email set.
    expect(scrubMeta).not.toHaveProperty('recipientEmails');
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  it('F7 content-scrub outcome:failed blocks member_erased (cascadesComplete:false)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsContentScrub.scrubContentForMember = vi.fn(
      async () => ({ outcome: 'failed' }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    // The scrub committed (member IS erased) but the F7 content cascade is
    // incomplete → member_erased WITHHELD for the US2d reconciler.
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // Best-effort isolation: a content-scrub failure must NOT abort the OTHER
  // cascades. The F7-cancel / F8-renewals / F1-user cascades all still run even
  // when the content scrub reports failed (each cascade is self-contained).
  it('a failing F7 content-scrub does NOT abort the other cascades (best-effort)', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    deps.broadcastsContentScrub.scrubContentForMember = vi.fn(
      async () => ({ outcome: 'failed' }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    // The F7-cancel + F8-renewals + F1-user cascades still ran — a content-scrub
    // failure flips the flag but does not short-circuit the rest.
    expect(deps.broadcastsCascade.cancelInFlightForMember).toHaveBeenCalledTimes(1);
    expect(deps.renewalsCascade.cancelInFlightForMember).toHaveBeenCalledTimes(1);
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith('u-1', expect.anything());
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // A THROWING F7 content-scrub adapter (the adapter is documented never-throws,
  // but the cascade block guards defensively, mirroring the F1/F7/F8 blocks).
  // The throw is caught, flips allCascadesClean=false, and withholds
  // member_erased — it never escapes the use-case.
  it('a THROWING F7 content-scrub is caught → cascadesComplete:false + no member_erased', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsContentScrub.scrubContentForMember = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // ---------------------------------------------------------------------------
  // COMP-1 US2b — the F7 broadcast-DELIVERY tombstone runs INSIDE the atomic
  // members-scrub tx (the 2026-06-18 2nd /code-review HIGH fix), NOT post-
  // commit. It is therefore part of the ATOMIC erasure — a throw rolls the
  // whole scrub tx back (server_error), unlike the best-effort post-commit
  // cascades which only flip cascadesComplete.
  // ---------------------------------------------------------------------------

  it('tombstones deliveries in the atomic scrub tx, keyed on the all-contact redaction set (login axis dropped)', async () => {
    const deps = buildEraseDeps();
    // COMP-1 FIX-3 — the tombstone reads listTombstoneEmailsForMemberInTx (all
    // contact emails MINUS peer-live-claimed), not the live-only set. The login
    // axis is still excluded (it never enters the tombstone set).
    deps.contactRepo.listTombstoneEmailsForMemberInTx = vi.fn(async () => [
      'contact-a@example.com',
    ]);
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(async () => ['u-1']);
    deps.userEmails.listEmailsForUsersInTx = vi.fn(async () =>
      ok(['login@example.com']),
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(
      deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx,
    ).toHaveBeenCalledTimes(1);
    const [, , emails] =
      deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx.mock.calls[0]!;
    // The all-contact redaction set (FIX-3) — the linked-login email is NOT in it.
    expect([...emails]).toEqual(['contact-a@example.com']);
    expect([...emails]).not.toContain('login@example.com');
  });

  it('a THROWING in-tx delivery tombstone rolls the whole atomic scrub back (server_error, no member_erased)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx = vi.fn(
      async () => {
        throw new Error('append-only trigger raised');
      },
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    // ATOMIC: the tombstone is part of the scrub tx, so a throw fails the whole
    // erasure (server_error) — it is NOT a best-effort post-commit cascade.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('server_error');
    // No member_erased completion proof (the scrub itself failed).
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  it('threads the in-tx tombstone count into the content-scrub meta (single audit records both axes)', async () => {
    const deps = buildEraseDeps();
    deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx = vi.fn(
      async () => ({ tombstonedCount: 5 }),
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const [, , scrubMeta] =
      deps.broadcastsContentScrub.scrubContentForMember.mock.calls[0]!;
    expect(scrubMeta.tombstonedCount).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // COMP-1 US2c — F6 event-registration fan-out erasure cascade (Task 5).
  // Hard-deletes every F6 event registration matched to the erased member (each
  // carries the attendee's email / name / company), crediting back any consumed
  // benefit quota per registration. Runs POST-COMMIT, mirroring the F1 / F7
  // content-scrub cascades — order-independent of them. The F6 fan-out keys on
  // `matched_member_id = member` (a member link NOT scrubbed by erasure) +
  // hard-deletes, so it is re-drive-stable by construction: a re-drive
  // re-discovers the surviving registrations and completes the remainder. A
  // `partial` (≥1 registration failed) OR `failed` outcome — or a throw — flips
  // allCascadesClean=false and withholds member_erased so the US2d reconciler
  // re-drives — the SAME gating the F1/F7/F8 cascades use.
  // ---------------------------------------------------------------------------

  it('erases the F6 registrations post-commit (tenant, memberId, meta) and stays clean on success', async () => {
    const deps = buildEraseDeps();
    deps.eventRegistrationErasure.eraseAllForMember = vi.fn(
      async () => ({ outcome: 'ok', erasedCount: 3 }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(true);

    // Exactly one fan-out call, carrying the tenant context, the member id, and
    // the meta the per-registration F6 PII-erasure audits need — actorUserId +
    // requestId threaded verbatim.
    expect(
      deps.eventRegistrationErasure.eraseAllForMember,
    ).toHaveBeenCalledTimes(1);
    expect(
      deps.eventRegistrationErasure.eraseAllForMember,
    ).toHaveBeenCalledWith(deps.tenant, asMemberId('m-1'), {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).toContain('member_erased');
  });

  // `partial` = the fan-out ran but ≥1 registration failed (failedCount > 0).
  // The member-row erasure still succeeds, but the cascade-completion proof MUST
  // record it incomplete so the US2d reconciler re-drives the remaining rows.
  it('F6 fan-out outcome:partial blocks member_erased (cascadesComplete:false)', async () => {
    const deps = buildEraseDeps();
    deps.eventRegistrationErasure.eraseAllForMember = vi.fn(
      async () =>
        ({ outcome: 'partial', erasedCount: 2, failedCount: 1 }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    // The scrub committed (member IS erased) but ≥1 registration failed →
    // member_erased WITHHELD for the US2d reconciler.
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // `failed` = the fan-out call threw at the calling convention (defensive arm
  // — the F6 fan-out is itself never-erring). Like `partial`, it must block
  // member_erased so the reconciler re-drives.
  it('F6 fan-out outcome:failed blocks member_erased (cascadesComplete:false)', async () => {
    const deps = buildEraseDeps();
    deps.eventRegistrationErasure.eraseAllForMember = vi.fn(
      async () => ({ outcome: 'failed' }) as const,
    );
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });

  // The port adapter is documented never-throws, but the cascade block guards a
  // throw defensively (mirrors the F1/F7/F8 cascade try/catch) so a pathological
  // adapter cannot abort the remaining cascades or escape the use-case. A throw
  // is caught, flips allCascadesClean=false, and withholds member_erased.
  it('a THROWING F6 fan-out is caught → cascadesComplete:false + no member_erased, others still run (best-effort)', async () => {
    const deps = buildEraseDeps();
    deps.contactRepo.listAllLinkedUserIdsForMemberInTx = vi.fn(async () => [
      'u-1',
    ]);
    deps.eventRegistrationErasure.eraseAllForMember = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await eraseMember(
      asMemberId('m-1'),
      { reason: 'gdpr_erasure_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.cascadesComplete).toBe(false);
    // Best-effort isolation: the F7-cancel / F8-renewals / F1-user / F7-content
    // cascades all still ran — the F6 throw flips the flag but does not
    // short-circuit the rest.
    expect(deps.broadcastsCascade.cancelInFlightForMember).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.renewalsCascade.cancelInFlightForMember).toHaveBeenCalledTimes(
      1,
    );
    expect(deps.userErasure.eraseUser).toHaveBeenCalledWith(
      'u-1',
      expect.anything(),
    );
    expect(
      deps.broadcastsContentScrub.scrubContentForMember,
    ).toHaveBeenCalledTimes(1);
    const types = deps.audit.recordInTx.mock.calls.map(
      (c) => (c[2] as { type: string }).type,
    );
    expect(types).not.toContain('member_erased');
  });
});

// ---------------------------------------------------------------------------
// COMP-1 US3-A — Art.12 identity attestation threaded into the durable
// `member_erasure_requested` audit (Task 1). The core `eraseMemberSchema`
// accepts OPTIONAL attestation fields so the admin route can attest the
// requester's identity (Art.12) on the originating request, while the US2d
// reconciler's `{ reason }`-only re-drive stays valid. The attestation is
// snake_cased into the requested-audit payload — present ONLY when supplied
// (the route requires them; a system re-drive does not re-attest), so it is
// recorded exactly once on the originating admin request. NO new audit event
// type (the F3 count stays 31).
// ---------------------------------------------------------------------------
describe('US3-A — Art.12 attestation in member_erasure_requested payload', () => {
  // Helper: find the single `member_erasure_requested` audit call's payload by
  // filtering the recordInTx spy on the event descriptor's `.type` (3rd arg).
  const requestedPayload = (deps: ReturnType<typeof buildEraseDeps>) => {
    const call = deps.audit.recordInTx.mock.calls.find(
      (c) => (c[2] as { type: string }).type === 'member_erasure_requested',
    );
    return (call?.[2] as { payload: Record<string, unknown> } | undefined)
      ?.payload;
  };

  it('threads a full attestation (route-shaped) into the requested-audit payload', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        verificationMethod: 'in_person',
        note: 'DPO-2026-014',
      },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(requestedPayload(deps)).toMatchObject({
      member_id: MEMBER_ID,
      reason: 'gdpr_erasure_request',
      identity_verified: true,
      verification_method: 'in_person',
      note: 'DPO-2026-014',
    });
  });

  it('omits the attestation keys on a reconciler-shaped { reason }-only request', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'pdpa_deletion_request' },
      META,
      deps,
    );
    expect(res.ok).toBe(true);
    const payload = requestedPayload(deps);
    expect(payload).toMatchObject({ reason: 'pdpa_deletion_request' });
    // The optional Art.12 keys are ABSENT (not present-as-undefined) so the
    // append-only DPO log records a system re-drive with no spurious attestation.
    expect(payload).not.toHaveProperty('identity_verified');
    expect(payload).not.toHaveProperty('verification_method');
    expect(payload).not.toHaveProperty('note');
  });

  it('rejects an unknown verification method with invalid_body', async () => {
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        // 'telepathy' is not a member of the closed verificationMethodSchema
        // enum. `eraseMember`'s `input` is typed `unknown` (it safeParses at
        // the boundary), so this is not a compile error — the schema rejects it
        // at runtime with invalid_body, which is the contract under test.
        verificationMethod: 'telepathy',
      },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });

  it('rejects an unknown smuggled key with invalid_body (schema stays .strict())', async () => {
    // Locks the `.strict()` contract so a future change to `.passthrough()` /
    // `.strip()` (which would let an attacker smuggle arbitrary keys into the
    // append-only DPO audit payload) breaks this test. (Security INFO gap.)
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      { reason: 'gdpr_erasure_request', evilExtraKey: 'x' },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });

  it('rejects a note longer than 500 chars with invalid_body', async () => {
    // Locks the `note: z.string().max(500)` bound so a future removal/widening
    // can't silently land an unbounded note in the audit payload. (Security
    // INFO gap.)
    const deps = buildEraseDeps();
    const res = await eraseMember(
      MEMBER_ID,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        verificationMethod: 'in_person',
        note: 'x'.repeat(501),
      },
      META,
      deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.type).toBe('invalid_body');
  });
});
