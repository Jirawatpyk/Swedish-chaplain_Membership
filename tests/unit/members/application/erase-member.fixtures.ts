/**
 * Stub-deps factory for `eraseMember` unit tests (COMP-1 US1, Task 4).
 *
 * Returns port-shaped `vi.fn` stubs typed as `StubbedEraseDeps` — assignable
 * to the real `EraseMemberDeps` while keeping `.mock` accessors visible on the
 * individual deps so tests can assert call args (mirrors the
 * `StubbedArchiveDeps` pattern in `archive-member.test.ts`). The skeleton
 * talks to ports only, so only the methods it touches are stubbed; the
 * remaining port methods are filled in by the live adapters in Task 8.
 */
import { vi } from 'vitest';
import { ok } from '@/lib/result';
import type { EraseMemberDeps } from '@/modules/members/application/use-cases/erase-member';

/**
 * `EraseMemberDeps` with the stubbed port objects re-typed so their `vi.fn`
 * methods expose `.mock` (and `=`-reassignment in tests). The cast is a
 * structural widening — the stubs satisfy the real port shapes the skeleton
 * actually exercises.
 */
export type StubbedEraseDeps = EraseMemberDeps & {
  memberRepo: {
    findErasedAtById: ReturnType<typeof vi.fn>;
    findByIdInTx: ReturnType<typeof vi.fn>;
    scrubPiiInTx: ReturnType<typeof vi.fn>;
  };
  contactRepo: {
    listLinkedUserIdsForMemberInTx: ReturnType<typeof vi.fn>;
    scrubPiiForMemberInTx: ReturnType<typeof vi.fn>;
  };
  invitations: {
    softConsumePendingForUsersInTx: ReturnType<typeof vi.fn>;
  };
  sessions: { revokeAllForInTx: ReturnType<typeof vi.fn> };
  broadcastsCascade: { cancelInFlightForMember: ReturnType<typeof vi.fn> };
  renewalsCascade: { cancelInFlightForMember: ReturnType<typeof vi.fn> };
  audit: { recordInTx: ReturnType<typeof vi.fn> };
};

export function buildEraseDeps(): StubbedEraseDeps {
  const FAKE_MEMBER = { memberId: 'm-1', tenantId: 't-1', status: 'active' };
  return {
    tenant: { slug: 't-1' },
    memberRepo: {
      // Pre-flight existence+state read (COMP-1 LOW/M2 fix). Happy-path
      // default: member EXISTS and is NOT yet erased (erasedAt: null) — so the
      // requested-audit emits as before. Tests override this to report
      // not_found or an already-erased (erasedAt set) member.
      findErasedAtById: vi.fn(async () => ok({ erasedAt: null as Date | null })),
      findByIdInTx: vi.fn(async () => ok(FAKE_MEMBER)),
      scrubPiiInTx: vi.fn(async () => ok(undefined)),
    },
    contactRepo: {
      listLinkedUserIdsForMemberInTx: vi.fn(async () => [] as string[]),
      scrubPiiForMemberInTx: vi.fn(async () => ok({ scrubbedCount: 1 })),
    },
    invitations: {
      softConsumePendingForUsersInTx: vi.fn(async () => ({ revokedCount: 0 })),
    },
    sessions: {
      revokeAllForInTx: vi.fn(async () => ok({ revokedCount: 0 })),
    },
    broadcastsCascade: {
      cancelInFlightForMember: vi.fn(async () => ({
        outcome: 'ok',
        cancelledCount: 0,
      })),
    },
    renewalsCascade: {
      cancelInFlightForMember: vi.fn(async () => ({
        outcome: 'ok',
        cancelledCount: 0,
      })),
    },
    audit: { recordInTx: vi.fn(async () => ok(undefined)) },
    clock: { now: () => new Date('2026-06-16T00:00:00.000Z') },
  } as unknown as StubbedEraseDeps;
}
