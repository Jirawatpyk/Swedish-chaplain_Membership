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
  /** 108 PR-C T104 — rows whose member/contact back-references were nulled. */
  severImpl?: () => Promise<{ affected: number }>;
  /** F2-2 — the erased member's inline images, stamped in this same tx. */
  imageRows?: ReadonlyArray<Record<string, unknown>>;
  /** ROUND-2 R-M6 — omit `emitManyTyped` to exercise the per-row fallback. */
  noEmitManyTyped?: boolean;
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
    // ROUND-2 R-M6 — the batched emit. Optional on the port (196 annotated
    // doubles), so `auditImagesRemoved` prefers it and falls back to per-row
    // `emitTyped`; `overrides.noEmitManyTyped` exercises that fallback arm.
    ...(overrides.noEmitManyTyped === true ? {} : { emitManyTyped: vi.fn(async () => undefined) }),
  } as {
    emit: ReturnType<typeof vi.fn>;
    emitTyped: typeof auditEmitImpl;
    emitManyTyped?: ReturnType<typeof vi.fn>;
  };
  // 108 PR-C T104 — the suppression repo severs the erased member's
  // `member_id` / `contact_id` back-references (rows survive, email-keyed).
  // Default 0 so the pre-108 zero-work cases keep their meaning.
  const marketingUnsubscribes = {
    severMemberRefs: vi.fn(
      async () => (await overrides.severImpl?.()) ?? { affected: 0 },
    ),
  };
  // F119 review finding F2-2 — erasure redacted subject/body but never
  // reached the member's UPLOADED IMAGES, which sit at public blob URLs.
  const imagesRepo = {
    markDeletedForMember: vi.fn(
      async (_t: unknown, _m: unknown, _at: unknown, _tx: unknown) => overrides.imageRows ?? [],
    ),
  };
  return { broadcastsRepo, audit, marketingUnsubscribes, imagesRepo, fakeTx };
}

describe('scrubBroadcastContentForMember — F2-2: erasure reaches the images', () => {
  it('stamps every inline image of the erased member IN THE SCRUB TX and audits each', async () => {
    const deps = makeDeps({
      imageRows: [
        { id: 'img-1', ownerKind: 'broadcast', ownerId: 'b-1', contentHash: 'h1' },
        { id: 'img-2', ownerKind: 'broadcast', ownerId: 'b-2', contentHash: 'h2' },
      ],
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      reason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-1',
      requestId: 'req-erase',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.imagesMarked).toBe(2);
    // Same transaction as the content redaction — a stamp that commits without
    // the redaction, or vice versa, is the forensic gap Principle I forbids.
    expect(deps.imagesRepo.markDeletedForMember).toHaveBeenCalledTimes(1);
    expect(deps.imagesRepo.markDeletedForMember.mock.calls[0]![3]).toBe(deps.fakeTx);

    // ROUND-2 R-M6 — ONE batched call, not N round-trips. A long-standing
    // member's erasure can stamp dozens of images, and each `audit.emit` was a
    // separate statement inside the erasure transaction, which holds the
    // member row and every cascade write open for its whole length.
    const batched = deps.audit.emitManyTyped!.mock.calls;
    expect(batched).toHaveLength(1);
    expect(batched[0]![0]).toBe(deps.fakeTx);
    const rows = batched[0]![1] as ReadonlyArray<{
      eventType: string;
      payload: Record<string, unknown>;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.eventType)).toEqual([
      'broadcast_image_removed',
      'broadcast_image_removed',
    ]);
    expect(rows[0]!.payload).toMatchObject({
      image_id: 'img-1',
      reason: 'member_erased',
      blob_deleted: false,
      actor_role: 'system',
    });
    expect(rows[1]!.payload).toMatchObject({ image_id: 'img-2' });
    // A deletion is not member activity: never the snake_case trigger key.
    expect(Object.keys(rows[0]!.payload)).not.toContain('member_id');
    // The per-row path is not ALSO used.
    expect(
      deps.audit.emitTyped.mock.calls.filter(
        (c) => (c[1] as { eventType: string }).eventType === 'broadcast_image_removed',
      ),
    ).toHaveLength(0);
  });

  it('R-M6 fallback: an audit port without `emitManyTyped` still writes one row per image', async () => {
    const deps = makeDeps({
      noEmitManyTyped: true,
      imageRows: [
        { id: 'img-1', ownerKind: 'broadcast', ownerId: 'b-1', contentHash: 'h1' },
        { id: 'img-2', ownerKind: 'broadcast', ownerId: 'b-2', contentHash: 'h2' },
      ],
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      initiatedByUserId: 'admin-1',
      requestId: 'req-erase',
    });

    expect(result.ok).toBe(true);
    const removals = deps.audit.emitTyped.mock.calls.filter(
      (c) => (c[1] as { eventType: string }).eventType === 'broadcast_image_removed',
    );
    expect(removals).toHaveLength(2);
    expect(removals.every((c) => c[0] === deps.fakeTx)).toBe(true);
  });

  /**
   * ROUND-2 P-M2. `broadcast_content_redacted` is the erasure ATTESTATION —
   * the one row an auditor reads to see what the cascade reached. It carried
   * the content, delivery and suppression counts but not the image count, so
   * the axis that was added precisely because redacting `body_html` does not
   * delete the member's photograph was invisible in the evidence.
   */
  it('P-M2: the redaction attestation records `images_marked` alongside the other axes', async () => {
    const deps = makeDeps({
      imageRows: [
        { id: 'img-1', ownerKind: 'broadcast', ownerId: 'b-1', contentHash: 'h1' },
        { id: 'img-2', ownerKind: 'broadcast', ownerId: 'b-2', contentHash: 'h2' },
      ],
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: TOMBSTONED_COUNT,
      reason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-1',
      requestId: 'req-erase',
    });

    expect(result.ok).toBe(true);
    const attestation = deps.audit.emitTyped.mock.calls.find(
      (c) => (c[1] as { eventType: string }).eventType === 'broadcast_content_redacted',
    );
    expect(attestation).toBeDefined();
    expect((attestation![1] as { payload: Record<string, unknown> }).payload).toMatchObject({
      scrubbed_count: 2,
      tombstoned_count: TOMBSTONED_COUNT,
      suppression_refs_severed: 0,
      images_marked: 2,
      reason: 'gdpr_erasure_request',
    });
  });

  it('a member with no images is a clean no-op on the image axis', async () => {
    const deps = makeDeps();
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      initiatedByUserId: null,
      requestId: 'r',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.imagesMarked).toBe(0);
    expect(
      deps.audit.emit.mock.calls.filter(
        (c) => (c[1] as { eventType: string }).eventType === 'broadcast_image_removed',
      ),
    ).toHaveLength(0);
  });
});

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

  // Review 2026-09-07 (tests MEDIUM) — the port keeps `severMemberRefs`
  // optional so unrelated fixtures compile; this guard is the only thing
  // standing between a composition that forgot to wire it and an erasure
  // that COMPLETES while the erased member stays re-identifiable on
  // marketing_unsubscribes. Delete the guard and this case goes red.
  it('a composition without severMemberRefs FAILS the erasure inside the tx — no audit, no success', async () => {
    const deps = makeDeps({ severImpl: async () => ({ affected: 1 }) });
    delete (deps.marketingUnsubscribes as { severMemberRefs?: unknown }).severMemberRefs;
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      reason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-user-1',
      requestId: 'req-104-unwired',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('scrub.server_error');
    expect(deps.audit.emitTyped).not.toHaveBeenCalled();
  });

});

/**
 * 108 PR-C T104 (FR-056) — the erasure cascade severs the erased member's
 * back-references on `marketing_unsubscribes` (`member_id` AND the new
 * `contact_id`, migration 0297) while the email-keyed row survives, so the
 * tombstoned member id can no longer be re-identified through the
 * suppression list. Runs in the SAME tx as the content scrub, before the
 * audit, and is a third axis of "work" for the zero-work guard.
 */
describe('scrubBroadcastContentForMember — 108 PR-C severs suppression back-references (T104)', () => {
  it('severs in the same tx before the audit; the audit and the output carry the count', async () => {
    const deps = makeDeps({ severImpl: async () => ({ affected: 2 }) });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      reason: 'gdpr_erasure_request',
      initiatedByUserId: 'admin-user-1',
      requestId: 'req-104',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suppressionRefsSevered).toBe(2);

    expect(deps.marketingUnsubscribes.severMemberRefs).toHaveBeenCalledTimes(1);
    expect(deps.marketingUnsubscribes.severMemberRefs).toHaveBeenCalledWith(deps.fakeTx, 'test-tenant', memberId);
    const scrubOrder = deps.broadcastsRepo.scrubContentForMemberInTx.mock.invocationCallOrder[0]!;
    const severOrder = deps.marketingUnsubscribes.severMemberRefs.mock.invocationCallOrder[0]!;
    const auditOrder = deps.audit.emitTyped.mock.invocationCallOrder[0]!;
    expect(scrubOrder).toBeLessThan(severOrder);
    expect(severOrder).toBeLessThan(auditOrder);

    const [, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    expect(emitEvent.payload).toMatchObject({
      member_id: memberId,
      scrubbed_count: 2,
      tombstoned_count: 0,
      suppression_refs_severed: 2,
      cascade: 'f3_member_erasure',
    });
    expect(JSON.stringify(emitEvent.payload)).not.toMatch(/@/);
  });

  it('severed refs alone are work: scrubbed 0 + tombstoned 0 + severed 1 → the audit still fires', async () => {
    const deps = makeDeps({
      scrubImpl: async () => ({ scrubbedCount: 0 }),
      severImpl: async () => ({ affected: 1 }),
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      initiatedByUserId: null,
      requestId: null,
    });
    expect(result.ok).toBe(true);
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    const [, emitEvent] = deps.audit.emitTyped.mock.calls[0]!;
    expect(emitEvent.payload).toMatchObject({ scrubbed_count: 0, tombstoned_count: 0, suppression_refs_severed: 1 });
    expect(auditEmitCountSpy).toHaveBeenCalledWith('test-tenant', 'broadcast_content_redacted');
  });

  it('a sever failure fails the whole scrub (Result.err) — the tx rolls back, no audit', async () => {
    const deps = makeDeps({
      severImpl: async () => {
        throw new Error('neon: statement timeout');
      },
    });
    const result = await scrubBroadcastContentForMember(deps as never, {
      tenant,
      memberId,
      tombstonedCount: 0,
      initiatedByUserId: null,
      requestId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('scrub.server_error');
    expect(deps.audit.emitTyped).not.toHaveBeenCalled();
  });
});
