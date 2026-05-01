/**
 * Unit tests — `acknowledge-broadcasts-terms.ts` use-case (F7 US3 AS7).
 *
 * GDPR Art. 7 demonstrable-consent surface — Constitution Principle II
 * security-critical 100% branch coverage. Branches asserted:
 *   1. F3 bridge → mark_ack.member_not_found  → ack.member_not_found, no emit.
 *   2. F3 bridge → already-acknowledged       → idempotent ok({alreadyAcknowledged:true}),
 *                                                NO audit emit (regression
 *                                                guard: emitting twice would
 *                                                corrupt the consent trail).
 *   3. Happy path                             → ok + audit emitted with
 *                                                memberId + userId + locale +
 *                                                acknowledgedAt + retentionYears.
 *   4. Audit emit throws on first ack         → STILL returns ok (the F3
 *                                                column is the legal source
 *                                                of truth — surface error
 *                                                would force retry that
 *                                                hits the F3 idempotent
 *                                                path, missing the audit
 *                                                permanently). Emission
 *                                                failure is logged.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { acknowledgeBroadcastsTerms } from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('00000000-0000-0000-0000-00000000bbbb');
const actorUserId = 'user-1';

function fixedClock(now: Date) {
  return { now: () => now };
}

function partialBridge(
  markBroadcastsAcknowledged: MembersBridgePort['markBroadcastsAcknowledged'],
): MembersBridgePort {
  // The use-case only calls `markBroadcastsAcknowledged` — supply
  // throw stubs for the rest of the port surface.
  const notUsed = () => {
    throw new Error('not used in this test');
  };
  return {
    getMembersBySegment: notUsed as unknown as MembersBridgePort['getMembersBySegment'],
    getMemberPrimaryContact: notUsed as unknown as MembersBridgePort['getMemberPrimaryContact'],
    memberExistsInTenant: notUsed as unknown as MembersBridgePort['memberExistsInTenant'],
    lookupContactEmailInTenant: notUsed as unknown as MembersBridgePort['lookupContactEmailInTenant'],
    lookupMemberPrimaryContactEmailInTenant:
      notUsed as unknown as MembersBridgePort['lookupMemberPrimaryContactEmailInTenant'],
    getMembersHaltedInTenant: notUsed as unknown as MembersBridgePort['getMembersHaltedInTenant'],
    setMemberHalt: notUsed as unknown as MembersBridgePort['setMemberHalt'],
    markBroadcastsAcknowledged,
  };
}

describe('acknowledgeBroadcastsTerms', () => {
  const requestId = 'req-1';

  it('member_not_found — maps to ack.member_not_found, no audit emit', async () => {
    const audit: AuditPort = { emit: vi.fn<AuditPort['emit']>(async () => undefined) };
    const membersBridge = partialBridge(async () =>
      err({ kind: 'mark_ack.member_not_found' as const, memberId }),
    );

    const r = await acknowledgeBroadcastsTerms(
      {
        tenant,
        membersBridge,
        audit,
        clock: fixedClock(new Date('2026-05-01T05:00:00Z')),
      },
      { memberId, actorUserId, locale: 'en', requestId },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('ack.member_not_found');
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('already-acknowledged — idempotent ok with alreadyAcknowledged=true; NO audit emit', async () => {
    const audit: AuditPort = { emit: vi.fn<AuditPort['emit']>(async () => undefined) };
    const membersBridge = partialBridge(async () =>
      err({ kind: 'mark_ack.already_acknowledged' as const }),
    );

    const r = await acknowledgeBroadcastsTerms(
      {
        tenant,
        membersBridge,
        audit,
        clock: fixedClock(new Date('2026-05-01T05:00:00Z')),
      },
      { memberId, actorUserId, locale: 'th', requestId },
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('idempotent');
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('happy path — emits audit with full payload (Q15 demonstrable consent)', async () => {
    const emit = vi.fn<AuditPort['emit']>(async () => undefined);
    const audit: AuditPort = { emit };
    const membersBridge = partialBridge(async () => ok(undefined));
    const now = new Date('2026-05-01T05:00:00Z');

    const r = await acknowledgeBroadcastsTerms(
      { tenant, membersBridge, audit, clock: fixedClock(now) },
      { memberId, actorUserId, locale: 'sv', requestId },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('fresh');
      if (r.value.kind === 'fresh') {
        expect(r.value.acknowledgedAt).toEqual(now);
      }
    }
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![1];
    expect(event.eventType).toBe('member_acknowledged_broadcasts_terms');
    expect(event.tenantId).toBe(tenant.slug);
    expect(event.actorUserId).toBe(actorUserId);
    expect(event.requestId).toBe(requestId);
    expect(event.payload).toMatchObject({
      memberId,
      userId: actorUserId,
      acknowledgedAt: now.toISOString(),
      bannerLocale: 'sv',
      retentionYears: 5,
    });
  });

  it('Q19 per-tenant scope — acknowledging tenant A does not invoke bridge for tenant B (Round 4 H1)', async () => {
    // Regression guard: a refactor that hoists the lookup key above
    // the tenant context (e.g. global cache, badly-keyed memo) would
    // make a SweCham acknowledgement auto-acknowledge JCC. Explicit
    // assertion on the `tenantContext` argument forwarded to the bridge.
    const tenantA = asTenantContext('swecham');
    const tenantB = asTenantContext('jcc');
    const bridgeCalls: Array<{ tenantSlug: string }> = [];
    const audit: AuditPort = { emit: vi.fn<AuditPort['emit']>(async () => undefined) };
    const membersBridge = partialBridge(async (ctx) => {
      bridgeCalls.push({ tenantSlug: ctx.slug });
      return ok(undefined);
    });

    const now = new Date('2026-05-01T05:00:00Z');

    await acknowledgeBroadcastsTerms(
      { tenant: tenantA, membersBridge, audit, clock: fixedClock(now) },
      { memberId, actorUserId, locale: 'en', requestId },
    );

    expect(bridgeCalls).toEqual([{ tenantSlug: 'swecham' }]);
    expect(bridgeCalls).not.toContainEqual({ tenantSlug: tenantB.slug });

    // Audit row carries the acknowledging tenant only — never tenantB.
    const emit = audit.emit as ReturnType<typeof vi.fn>;
    expect(emit.mock.calls[0]![1].tenantId).toBe('swecham');
  });

  it('happy path with audit failure — returns ok (consent column is source of truth)', async () => {
    const audit: AuditPort = {
      emit: vi.fn<AuditPort['emit']>(async () => {
        throw new Error('audit transport down');
      }),
    };
    const membersBridge = partialBridge(async () => ok(undefined));
    const now = new Date('2026-05-01T05:00:00Z');

    const r = await acknowledgeBroadcastsTerms(
      { tenant, membersBridge, audit, clock: fixedClock(now) },
      { memberId, actorUserId, locale: 'en', requestId },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('fresh');
      if (r.value.kind === 'fresh') {
        expect(r.value.acknowledgedAt).toEqual(now);
      }
    }
  });
});
