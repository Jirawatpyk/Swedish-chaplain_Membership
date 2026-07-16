/**
 * 066 §4.4(1) — shared test stub for the invoicing `MembershipAccessPort`.
 *
 * Most record-payment tests exercise scenarios where the member is in good
 * standing; the terminated-membership gate must not fire. This stub returns
 * a fixed access so those tests don't have to seed a renewal cycle. Tests
 * that specifically exercise the gate wire the REAL bridge (via
 * `makeRecordPaymentDeps`) or override this stub.
 */
import type { MembershipAccessPort } from '@/modules/invoicing/application/ports/membership-access-port';

export function membershipAccessStub(
  access: 'full' | 'suspended' | 'terminated' = 'full',
): MembershipAccessPort {
  return {
    getMembershipAccess: async () => ({
      ok: true as const,
      value: {
        access,
        reason: access === 'full' ? 'in_good_standing' : 'grace_expired',
      },
    }),
  };
}
