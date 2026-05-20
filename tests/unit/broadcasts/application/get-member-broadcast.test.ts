/**
 * Unit tests โ€” `get-member-broadcast.ts` use-case (F7 US3 AS5 + AS3).
 *
 * Constitution Principle II: security-critical 100% branch coverage.
 * Branches asserted:
 *   1. Genuinely-absent broadcast โ’ returns broadcast.not_found, NO audit emit.
 *   2. Cross-member probe        โ’ returns broadcast.not_found + emits
 *                                  `broadcast_cross_member_probe` audit
 *                                  with correct payload.
 *   3. Audit emit throws on cross-member path โ’ still returns
 *                                  broadcast.not_found (anti-enumeration
 *                                  preserved at HTTP boundary).
 *   4. Owned broadcast โ’ returns ok with broadcast + DeliveryBreakdown
 *                        totals computed correctly.
 */
import { describe, expect, it, vi } from 'vitest';
import { getMemberBroadcast } from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';
import { asBroadcastId } from '@/modules/broadcasts';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('00000000-0000-0000-0000-00000000aaaa');
const broadcastId = asBroadcastId('11111111-1111-1111-1111-111111111111');
const actorUserId = 'user-1';
const requestId = 'req-1';

function makeRepoMocks(opts: {
  findOwned: BroadcastsRepo['findOwnedByMember'];
  aggregate?: BroadcastsRepo['aggregateDeliveryCountsForBroadcast'];
}): BroadcastsRepo {
  return {
    withTx: async (fn) => fn(null),
    insertDraft: async () => {
      throw new Error('not used');
    },
    updateDraft: async () => {
      throw new Error('not used');
    },
    updateDraftFromTemplate: async () => {
      throw new Error('not used in get-member-broadcast fixture');
    },
    findById: async () => null,
    findByIdInTx: async () => null,
    lockForUpdate: async () => null,
    applyTransition: async () => {
      throw new Error('not used');
    },
    attachResendIds: async () => {
      // no-op
    },
    attachAudienceId: async () => {
      // no-op
    },
    listByTenantStatus: async () => ({ rows: [], nextCursor: null }),
    countForMemberQuota: async () => ({ submittedOrApproved: 0, sent: 0 }),
    findByResendBroadcastIdBypassRls: async () => null,
    listForMemberPaginated: async () => ({
      rows: [],
      total: 0,
      totalPages: 0,
      page: 1,
    }),
    findOwnedByMember: opts.findOwned,
    aggregateDeliveryCountsForBroadcast:
      opts.aggregate ??
      (async () => ({
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 0,
        sent: 0,
      })),
    pruneExpiredDrafts: async () => ({ prunedCount: 0 }),
    listInFlightOwnedByMember: async () => [],
  };
}

function makeAuditEmitMock() {
  const emit = vi.fn<AuditPort['emit']>(async () => undefined);
  const audit: AuditPort = { emit };
  return { audit, emit };
}

describe('getMemberBroadcast', () => {
  it('not_found path โ€” absent row returns err({not_found}) and DOES NOT emit audit', async () => {
    const { audit, emit } = makeAuditEmitMock();
    const broadcastsRepo = makeRepoMocks({
      findOwned: async () => ({ broadcast: null, probeKind: 'not_found' }),
    });

    const result = await getMemberBroadcast(
      { tenant, broadcastsRepo, audit },
      { memberId, broadcastId, actorUserId, requestId },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast.not_found');
    expect(emit).not.toHaveBeenCalled();
  });

  it('cross_member path โ€” emits broadcast_cross_member_probe audit with correct payload', async () => {
    const { audit, emit } = makeAuditEmitMock();
    const broadcastsRepo = makeRepoMocks({
      findOwned: async () => ({ broadcast: null, probeKind: 'cross_member' }),
    });

    const result = await getMemberBroadcast(
      { tenant, broadcastsRepo, audit },
      { memberId, broadcastId, actorUserId, requestId },
    );

    expect(result.ok).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![1];
    expect(event.eventType).toBe('broadcast_cross_member_probe');
    expect(event.tenantId).toBe(tenant.slug);
    expect(event.actorUserId).toBe(actorUserId);
    expect(event.requestId).toBe(requestId);
    expect(event.payload).toMatchObject({
      memberId,
      broadcastId,
      retentionYears: 5,
    });
  });

  it('cross_member path โ€” audit emit failure does NOT change response (anti-enumeration preserved)', async () => {
    const audit: AuditPort = {
      emit: vi.fn<AuditPort['emit']>(async () => {
        throw new Error('audit transport down');
      }),
    };
    const broadcastsRepo = makeRepoMocks({
      findOwned: async () => ({ broadcast: null, probeKind: 'cross_member' }),
    });

    const result = await getMemberBroadcast(
      { tenant, broadcastsRepo, audit },
      { memberId, broadcastId, actorUserId, requestId },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast.not_found');
  });

  it('Round 4 H2 โ€” repo calls receive tenant.slug + memberId + broadcastId verbatim (cross-tenant safety)', async () => {
    // Regression guard: a refactor that drops tenantId from the repo
    // signature, or threads `''` / a wrong slug, would make a JCC member
    // probe SweCham broadcasts. Both calls (findOwnedByMember +
    // aggregateDeliveryCountsForBroadcast) MUST receive the acknowledging
    // tenant slug.
    const { audit } = makeAuditEmitMock();
    const findOwned = vi.fn<BroadcastsRepo['findOwnedByMember']>(async () => ({
      broadcast: {
        tenantId: tenant.slug,
        broadcastId,
        requestedByMemberId: memberId,
        subject: 'x',
        bodyHtml: '<p/>',
        status: 'sent',
        estimatedRecipientCount: 1,
        // R4.1 C-4 — R3.3 H-4 made templateProvenance REQUIRED on
        // Broadcast. This fixture uses `as unknown as Broadcast` cast
        // which bypasses the compile-time check, so the field has to
        // be added by hand to keep production-vs-test shape aligned.
        templateProvenance: null,
      } as unknown as Broadcast,
      probeKind: 'owned' as const,
    }));
    const aggregate = vi.fn<BroadcastsRepo['aggregateDeliveryCountsForBroadcast']>(
      async () => ({
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 0,
        sent: 0,
      }),
    );
    const broadcastsRepo = makeRepoMocks({ findOwned, aggregate });

    await getMemberBroadcast(
      { tenant, broadcastsRepo, audit },
      { memberId, broadcastId, actorUserId, requestId },
    );

    expect(findOwned).toHaveBeenCalledWith(tenant.slug, memberId, broadcastId);
    expect(aggregate).toHaveBeenCalledWith(tenant.slug, broadcastId);
  });

  it('owned path โ€” returns broadcast + DeliveryBreakdown with correct total', async () => {
    const { audit } = makeAuditEmitMock();
    const broadcast = {
      tenantId: tenant.slug,
      broadcastId,
      requestedByMemberId: memberId,
      subject: 'Test',
      bodyHtml: '<p>x</p>',
      status: 'sent',
      estimatedRecipientCount: 130,
      submittedAt: new Date(),
      sentAt: new Date(),
      // R4.1 C-4 — see L165 sibling comment for rationale.
      templateProvenance: null,
    } as unknown as Broadcast;
    const broadcastsRepo = makeRepoMocks({
      findOwned: async () => ({ broadcast, probeKind: 'owned' }),
      aggregate: async () => ({
        delivered: 128,
        bounced: 1,
        softBounced: 1,
        complained: 0,
        sent: 0,
      }),
    });

    const result = await getMemberBroadcast(
      { tenant, broadcastsRepo, audit },
      { memberId, broadcastId, actorUserId, requestId },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.broadcast).toBe(broadcast);
      expect(result.value.delivery).toEqual({
        delivered: 128,
        bounced: 1,
        softBounced: 1,
        complained: 0,
        sent: 0,
        total: 130,
      });
    }
  });
});
