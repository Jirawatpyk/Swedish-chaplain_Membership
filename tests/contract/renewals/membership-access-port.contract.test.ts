/**
 * 059-membership-suspension Task 4 — `MembershipAccessPort` contract test.
 *
 * Cross-module bridge port: F7 (broadcasts) + F3 (members) use-cases ask
 * F8 (renewals) for a member's current benefit-access state without
 * reaching into F8's Domain/Infrastructure directly.
 *
 * Contract: any adapter must return a discriminated `{ access, reason }`
 * on success, and an `err({ kind: 'membership_access.lookup_error' })` —
 * NOT a throw — on infra failure, so calling use-cases can fail CLOSED.
 *
 * This is a pure port-shape test (fake adapter) — it does NOT need live
 * Neon. The real wired-through adapter (`membershipAccessBridge`) is
 * integration-tested in Task 5.
 */
import { describe, expect, it } from 'vitest';
import type { MembershipAccessPort } from '@/modules/broadcasts/application/ports/membership-access-port';

function suite(make: () => MembershipAccessPort) {
  it('exposes getMembershipAccess as a function', () => {
    expect(typeof make().getMembershipAccess).toBe('function');
  });

  it('resolves a discriminated {access, reason} pair on success', async () => {
    const port = make();
    const result = await port.getMembershipAccess(
      // Fake adapters under test don't read the tenant arg — a minimal
      // stand-in avoids coupling this contract test to the real
      // `asTenantContext` constructor.
      { slug: 'test-tenant' } as unknown as Parameters<
        MembershipAccessPort['getMembershipAccess']
      >[0],
      'member-1',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.access).toBe('suspended');
      expect(result.value.reason).toBe('unpaid');
    }
  });
}

describe('MembershipAccessPort contract', () => {
  suite(() => ({
    async getMembershipAccess() {
      return { ok: true, value: { access: 'suspended', reason: 'unpaid' } };
    },
  }));

  it('surfaces infra failures as a lookup_error kind, not a throw', async () => {
    const failingAdapter: MembershipAccessPort = {
      async getMembershipAccess() {
        return { ok: false, error: { kind: 'membership_access.lookup_error' } };
      },
    };

    const result = await failingAdapter.getMembershipAccess(
      { slug: 'test-tenant' } as unknown as Parameters<
        MembershipAccessPort['getMembershipAccess']
      >[0],
      'member-1',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('membership_access.lookup_error');
    }
  });
});
