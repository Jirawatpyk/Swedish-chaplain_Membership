/**
 * COMP-1 US2b — unit coverage for `scrubBroadcastContentForMember`.
 *
 * Mirrors `cancel-in-flight-broadcasts-for-member.test.ts`: stub the
 * repo's `withTx` to invoke the callback with a fake tx, stub the
 * content-scrub repo method + `audit.emit`. The DELIVERY tombstone moved
 * OUT of this use-case into the caller's atomic scrub tx (the 2026-06-18
 * 2nd /code-review HIGH fix); this use-case now does CONTENT only and
 * threads the caller's `tombstonedCount` into the single audit. Asserts:
 *   - the content-scrub repo method called with `(tx, tenantSlug, memberId)`;
 *   - the delivery-tombstone repo method is NOT called here;
 *   - ONE `broadcast_content_redacted` audit emitted with both counts in
 *     the payload + NO PII (email) in the summary/payload;
 *   - the content scrub + the audit emit run inside the SAME `withTx`
 *     callback (one atomic tx);
 *   - returns `ok({ scrubbedCount: 2, tombstonedCount: 3 })` (the tombstoned
 *     count echoed back from the input);
 *   - a repo throw → typed `Result.err` (`scrub.server_error`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auditEmitCountSpy, contentScrubFailedSpy } = vi.hoisted(() => ({
  auditEmitCountSpy: vi.fn(),
  contentScrubFailedSpy: vi.fn(),
}));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      auditEmitCount: auditEmitCountSpy,
      contentScrubFailed: contentScrubFailedSpy,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { scrubBroadcastContentForMember } from '@/modules/broadcasts/application/use-cases/scrub-broadcast-content-for-member';
import type { AuditEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
// The delivery-tombstone count the CALLER produced in its atomic scrub tx.
// This use-case no longer tombstones deliveries; it echoes this count into the
// single `broadcast_content_redacted` audit so both axes are recorded.
const TOMBSTONED_COUNT = 3;

interface MakeDepsOverrides {
  scrubImpl?: () => Promise<{ scrubbedCount: number }>;
  auditEmitImpl?: () => Promise<void>;
}

function makeDeps(overrides: MakeDepsOverrides = {}) {
  const fakeTx = { __fakeTx: true };
  const broadcastsRepo = {
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx),
    ),
    scrubContentForMemberInTx: vi.fn(
      async () =>
        (await overrides.scrubImpl?.()) ?? { scrubbedCount: 2 },
    ),
    // The delivery tombstone moved to the caller's atomic tx; the use-case must
    // NOT call this. Kept as a spy so the test can assert it is NEVER invoked.
    tombstoneDeliveriesForMemberInTx: vi.fn(async () => ({ tombstonedCount: 0 })),
  };
  // The use-case emits via `emitTyped` (the S1 type-design fix — the
  // `broadcast_content_redacted` payload is compile-checked against
  // F7AuditPayloadShapes). `emit` is kept as a spy so the test can assert the
  // untyped path is NOT used. The production f7AuditAdapter routes `emitTyped`
  // → `emit`, so at runtime they are equivalent.
  const auditEmitImpl = vi.fn(async (_tx: unknown, _event: AuditEmitInput) => {
    if (overrides.auditEmitImpl) await overrides.auditEmitImpl();
  });
  const audit = {
    emit: vi.fn(),
    emitTyped: auditEmitImpl,
  };
  return { broadcastsRepo, audit, fakeTx };
}

describe('scrubBroadcastContentForMember (COMP-1 US2b)', () => {
  beforeEach(() => {
    auditEmitCountSpy.mockReset();
    contentScrubFailedSpy.mockReset();
  });

  it('happy path: scrubs content, emits one audit with both counts, does NOT tombstone deliveries here', async () => {
    const deps = makeDeps();
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      reason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-user-1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scrubbedCount).toBe(2);
    // The tombstoned count is echoed back from the input (produced by the
    // caller's atomic tx), not computed here.
    expect(result.value.tombstonedCount).toBe(3);

    // Content scrub is memberId-keyed (requested_by_member_id).
    expect(deps.broadcastsRepo.scrubContentForMemberInTx).toHaveBeenCalledTimes(
      1,
    );
    expect(
      deps.broadcastsRepo.scrubContentForMemberInTx,
    ).toHaveBeenCalledWith(deps.fakeTx, 'test-tenant', memberId);
    // The delivery tombstone is NOT run here — it moved to the caller's atomic
    // members-scrub tx (the 2026-06-18 2nd /code-review HIGH fix).
    expect(
      deps.broadcastsRepo.tombstoneDeliveriesForMemberInTx,
    ).not.toHaveBeenCalled();

    // Exactly one audit emit, inside the same tx, with the counts. Emitted via
    // the typed path (S1); the untyped `emit` is never touched.
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    expect(deps.audit.emit).not.toHaveBeenCalled();
    const [emitTx, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    expect(emitTx).toBe(deps.fakeTx);
    expect(emitEvent.eventType).toBe('broadcast_content_redacted');
    expect(emitEvent.tenantId).toBe('test-tenant');
    expect(emitEvent.requestId).toBe('req-1');
    expect(emitEvent.actorUserId).toBe('admin-user-1');
    expect(emitEvent.payload).toMatchObject({
      member_id: memberId,
      scrubbed_count: 2,
      tombstoned_count: 3,
      reason: 'gdpr_erasure_request',
      // Forensic join key: the audit row carries the same
      // `cascade: 'f3_member_erasure'` tag the logger emits, so an
      // operator can correlate the audit trail with the structured log.
      cascade: 'f3_member_erasure',
    });

    // Success path must NOT fire the failure metric.
    expect(contentScrubFailedSpy).not.toHaveBeenCalled();
  });

  it('zero work (scrubbed=0 AND caller tombstoned=0): returns ok WITHOUT emitting an audit', async () => {
    // Mirror the cancel cascade's zero-work early-return: a member who
    // authored nothing AND whose caller tombstoned no deliveries, or a
    // reconciler re-drive after a prior pass, must NOT emit a
    // `broadcast_content_redacted` audit row (audit hygiene — no audit noise
    // for a no-op).
    const deps = makeDeps({
      scrubImpl: async () => ({ scrubbedCount: 0 }),
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      initiatedByUserId: null,
      requestId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scrubbedCount).toBe(0);
    expect(result.value.tombstonedCount).toBe(0);
    // No audit on zero work (neither the typed nor the untyped path).
    expect(deps.audit.emitTyped).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(auditEmitCountSpy).not.toHaveBeenCalled();
    // The content scrub still ran (we only skip the audit, not the work); the
    // delivery tombstone is never run here.
    expect(deps.broadcastsRepo.scrubContentForMemberInTx).toHaveBeenCalledTimes(
      1,
    );
    expect(
      deps.broadcastsRepo.tombstoneDeliveriesForMemberInTx,
    ).not.toHaveBeenCalled();
    // No failure either.
    expect(contentScrubFailedSpy).not.toHaveBeenCalled();
  });

  it('partial work (scrubbed=0, caller tombstoned>0): still emits the audit', async () => {
    // The content scrub matched nothing, but the caller tombstoned deliveries
    // in its atomic tx — there IS real work, so the audit must still fire (the
    // skip is strictly the all-zero case) so the tombstone count is recorded.
    const deps = makeDeps({
      scrubImpl: async () => ({ scrubbedCount: 0 }),
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 2,
      initiatedByUserId: null,
      requestId: null,
    });
    expect(result.ok).toBe(true);
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    expect(auditEmitCountSpy).toHaveBeenCalledTimes(1);
    // The audit records the caller's tombstone count.
    const [, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    expect(emitEvent.payload).toMatchObject({
      scrubbed_count: 0,
      tombstoned_count: 2,
    });
  });

  it('orders scrub → audit inside one withTx callback', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      scrubImpl: async () => {
        order.push('scrub');
        return { scrubbedCount: 2 };
      },
      auditEmitImpl: async () => {
        order.push('audit');
      },
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      initiatedByUserId: null,
      requestId: null,
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(['scrub', 'audit']);
    // Single tx wrapping both.
    expect(deps.broadcastsRepo.withTx).toHaveBeenCalledTimes(1);
  });

  it('no PII in the audit summary or payload (only opaque ids + counts)', async () => {
    const deps = makeDeps();
    await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      initiatedByUserId: null,
      requestId: null,
    });
    const [, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    const serialised = JSON.stringify({
      summary: emitEvent.summary,
      payload: emitEvent.payload,
    });
    // The summary references the opaque member id but never an email.
    expect(serialised).not.toMatch(/@/);
    expect(emitEvent.summary).toContain(memberId as unknown as string);
  });

  it('defaults actorUserId to "system" when initiatedByUserId is null', async () => {
    const deps = makeDeps();
    await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      initiatedByUserId: null,
      requestId: null,
    });
    const [, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    expect(emitEvent.actorUserId).toBe('system');
  });

  it('repo throw → Result.err (scrub.server_error), audit not emitted', async () => {
    const deps = makeDeps({
      scrubImpl: async () => {
        throw new Error('Neon: connection terminated');
      },
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      initiatedByUserId: null,
      requestId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('scrub.server_error');
    expect(result.error.message).toContain('connection terminated');
    expect(deps.audit.emitTyped).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    // Failure metric fires on the catch path so a stuck content-scrub
    // cascade is alertable (not just log-greppable), PII-free (tenant only).
    expect(contentScrubFailedSpy).toHaveBeenCalledTimes(1);
    expect(contentScrubFailedSpy).toHaveBeenCalledWith('test-tenant');
  });

  it('audit emit throw → Result.err (audit-before-success: the whole scrub rolls back, counts NOT leaked)', async () => {
    // The audit emit runs INSIDE the withTx callback, AFTER both repo
    // scrubs. A throw there propagates out of `withTx` (rolling the tx
    // back) → the outer catch → typed err. This pins the audit-before-
    // success invariant: an audit-row failure must fail the cascade
    // (the members adapter maps `scrub.server_error` → outcome:'failed'),
    // never report a redaction that wasn't durably audited.
    const deps = makeDeps({
      auditEmitImpl: async () => {
        throw new Error('audit insert failed');
      },
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      initiatedByUserId: null,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('scrub.server_error');
    expect(result.error.message).toContain('audit insert failed');
    // The scrub counts MUST NOT be surfaced as a success — the err
    // branch carries no `scrubbedCount`/`tombstonedCount`.
    expect(result.error).not.toHaveProperty('scrubbedCount');
    expect(result.error).not.toHaveProperty('tombstonedCount');
    // The content scrub ran (the throw is at the audit step), but the tx
    // rolled back so nothing is durable. The delivery tombstone never runs here.
    expect(deps.broadcastsRepo.scrubContentForMemberInTx).toHaveBeenCalledTimes(
      1,
    );
    expect(
      deps.broadcastsRepo.tombstoneDeliveriesForMemberInTx,
    ).not.toHaveBeenCalled();
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    // An audit-emit throw is also a cascade failure → the failure metric
    // fires (the catch wraps both the repo scrubs and the audit emit).
    expect(contentScrubFailedSpy).toHaveBeenCalledTimes(1);
    expect(contentScrubFailedSpy).toHaveBeenCalledWith('test-tenant');
  });
});
