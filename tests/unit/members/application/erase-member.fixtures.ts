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
    listAllLinkedUserIdsForMemberInTx: ReturnType<typeof vi.fn>;
    listEmailsForMemberInTx: ReturnType<typeof vi.fn>;
    listLiveEmailsForMemberInTx: ReturnType<typeof vi.fn>;
    listTombstoneEmailsForMemberInTx: ReturnType<typeof vi.fn>;
    scrubPiiForMemberInTx: ReturnType<typeof vi.fn>;
  };
  invitations: {
    softConsumePendingForUsersInTx: ReturnType<typeof vi.fn>;
  };
  sessions: { revokeAllForInTx: ReturnType<typeof vi.fn> };
  broadcastsCascade: { cancelInFlightForMember: ReturnType<typeof vi.fn> };
  renewalsCascade: { cancelInFlightForMember: ReturnType<typeof vi.fn> };
  // COMP-1 US2a — F1 linked-login erasure cascade (Task 6). A real `vi.fn`
  // (not a double-cast) so the cascade tests can assert call args + override
  // the per-user result. Default: `ok({ erased: true })` (login anonymised).
  userErasure: { eraseUser: ReturnType<typeof vi.fn> };
  // COMP-1 US2b — F7 broadcast CONTENT scrub cascade (post-commit). A real
  // `vi.fn` so the cascade tests can assert the (tenant, memberId, meta) call
  // args + override the outcome. Default: `{ outcome: 'ok' }` (the member
  // authored nothing, or the scrub ran clean).
  broadcastsContentScrub: { scrubContentForMember: ReturnType<typeof vi.fn> };
  // COMP-1 US2b — F7 broadcast-DELIVERY tombstone, run INSIDE the atomic
  // scrub tx (the 2026-06-18 2nd /code-review HIGH fix moved it out of the
  // post-commit content cascade). A real `vi.fn` so tests can assert the
  // (tx, tenantSlug, recipientEmails) call args + override the count. Default:
  // `{ tombstonedCount: 0 }` (the member received no broadcasts).
  broadcastsDeliveryTombstone: {
    tombstoneDeliveriesInTx: ReturnType<typeof vi.fn>;
    // COMP-1 FIX-9 — element-wise cross-author custom-recipient redaction, run
    // INSIDE the atomic scrub tx (next to the delivery tombstone). A real
    // `vi.fn` so tests can assert the (tx, tenantSlug, recipientEmails) call
    // args. Default: `{ redactedCount: 0 }`.
    redactCustomRecipientEmailsInTx: ReturnType<typeof vi.fn>;
  };
  // COMP-1 US2a (M1/L1) — token invalidation + linked-login email read +
  // pending-outbox cancel, all run inside the scrub tx.
  tokens: { invalidateAllActiveForUsersInTx: ReturnType<typeof vi.fn> };
  userEmails: { listEmailsForUsersInTx: ReturnType<typeof vi.fn> };
  outboxCancel: { cancelPendingForEmailsInTx: ReturnType<typeof vi.fn> };
  // COMP-1 US2c — F6 event-registration fan-out erasure cascade (post-commit).
  // A real `vi.fn` so the cascade tests can assert the (tenant, memberId, meta)
  // call args + override the discriminated-union outcome. Default:
  // `{ outcome: 'ok', erasedCount: 0 }` (the member had no matched
  // registrations). Tests override to return `{ outcome: 'partial', ... }` /
  // `{ outcome: 'failed' }` (→ allCascadesClean=false, member_erased withheld).
  eventRegistrationErasure: { eraseAllForMember: ReturnType<typeof vi.fn> };
  // COMP-1 US3-C — in-tx Resend audience-contact derivation (FAIL-LOUD, runs
  // inside the scrub tx) + post-commit best-effort sub-processor propagation.
  // Real `vi.fn`s so cascade tests can assert call args + override the
  // derived pairs / propagation outcome. Defaults: no audience pairs, clean
  // ('ok') propagation with 0 contacts removed.
  broadcastsAudienceDerivation: {
    listMemberAudienceContactsInTx: ReturnType<typeof vi.fn>;
  };
  subprocessorErasure: { propagate: ReturnType<typeof vi.fn> };
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
      // FILTERED (removed_at IS NULL) — drives the in-tx session/invitation
      // revocation cascade. Default [].
      listLinkedUserIdsForMemberInTx: vi.fn(async () => [] as string[]),
      // UNFILTERED (US2a) — drives the post-commit F1 linked-login erasure
      // work-list. Survives the contacts removed_at scrub so the US2d
      // reconciler can re-attempt a previously-failed login on a re-drive.
      // Default []; F1-cascade tests override this (not the filtered variant).
      listAllLinkedUserIdsForMemberInTx: vi.fn(async () => [] as string[]),
      // COMP-1 US2a (L1) — real contact emails pre-scrub. The UNFILTERED variant
      // is used by the USER-keyed work-lists; the LIVE-only variant
      // (listLiveEmailsForMemberInTx) feeds the address-keyed outbox cancel-set
      // (live contacts only — a removed contact's email is ambiguously owned).
      listEmailsForMemberInTx: vi.fn(async () => [] as string[]),
      listLiveEmailsForMemberInTx: vi.fn(async () => [] as string[]),
      // COMP-1 FIX-3 — the email set for the email-keyed REDACTION ops (delivery
      // tombstone + Resend audience derivation + cross-author custom-recipient
      // redaction): all contact emails (any removed_at) MINUS peer-live-claimed.
      // Default []; tests that assert the redaction args override this.
      listTombstoneEmailsForMemberInTx: vi.fn(async () => [] as string[]),
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
    // F1 linked-login erasure (US2a). Default success: the login was
    // anonymised. Tests override to return `ok({ erased: false })` (login
    // already gone — still success) or `err({ code })` (erasure failed → the
    // cascade flips allCascadesClean=false and withholds member_erased).
    userErasure: {
      eraseUser: vi.fn(async () => ok({ erased: true })),
    },
    // F7 broadcast CONTENT scrub (US2b). Default clean: the member authored
    // nothing (count 0) or the scrub ran end-to-end. The `'ok'` variant of the
    // discriminated-union return REQUIRES both counts. Tests override to return
    // `{ outcome: 'failed' }` → the cascade flips allCascadesClean=false and
    // withholds member_erased.
    broadcastsContentScrub: {
      scrubContentForMember: vi.fn(async () => ({
        outcome: 'ok',
        scrubbedCount: 0,
        tombstonedCount: 0,
      })),
    },
    // F7 broadcast-DELIVERY tombstone (US2b), run inside the atomic scrub tx.
    // Default: 0 rows tombstoned (the member received no broadcasts). Tests
    // override to assert the (tx, tenantSlug, recipientEmails) args or to
    // return a non-zero count (threaded to the content-scrub audit).
    broadcastsDeliveryTombstone: {
      tombstoneDeliveriesInTx: vi.fn(async () => ({ tombstonedCount: 0 })),
      // COMP-1 FIX-9 — element-wise cross-author custom-recipient redaction,
      // run inside the atomic scrub tx. Default: 0 rows redacted. Tests can
      // assert the (tx, tenantSlug, recipientEmails) args or override the count.
      redactCustomRecipientEmailsInTx: vi.fn(async () => ({ redactedCount: 0 })),
    },
    // COMP-1 US2a (M1/L1). Defaults are clean no-ops: no active tokens to
    // invalidate, no linked-login emails, 0 outbox rows cancelled. Tests that
    // exercise the cancel path override these.
    tokens: {
      invalidateAllActiveForUsersInTx: vi.fn(async () =>
        ok({ invalidatedEmails: [] as string[] }),
      ),
    },
    userEmails: {
      listEmailsForUsersInTx: vi.fn(async () => ok([] as string[])),
    },
    outboxCancel: {
      cancelPendingForEmailsInTx: vi.fn(async () => ok({ cancelledCount: 0 })),
    },
    // F6 event-registration fan-out erasure (US2c). Default clean: the member
    // had no matched registrations (erasedCount 0). The `'ok'` variant of the
    // discriminated-union return REQUIRES `erasedCount`. Tests override to
    // return `{ outcome: 'partial', erasedCount, failedCount }` /
    // `{ outcome: 'failed' }` → the cascade flips allCascadesClean=false and
    // withholds member_erased.
    eventRegistrationErasure: {
      eraseAllForMember: vi.fn(async () => ({ outcome: 'ok', erasedCount: 0 })),
    },
    // COMP-1 US3-C. Default in-tx derivation: no audience pairs (member received
    // no audience-bearing broadcasts). Default propagation: clean 'ok' with 0
    // contacts removed. Tests that exercise the sub-processor cascade override
    // these (e.g. return pairs from the derivation + a 'failed' propagation).
    broadcastsAudienceDerivation: {
      listMemberAudienceContactsInTx: vi.fn(
        async () => [] as ReadonlyArray<{ audienceId: string; email: string }>,
      ),
    },
    subprocessorErasure: {
      propagate: vi.fn(async () => ({
        resendOutcome: 'ok' as const,
        resendContactsRemoved: 0,
        resendContactsFailed: 0,
        stripeOutcome: 'ok' as const,
      })),
    },
    audit: { recordInTx: vi.fn(async () => ok(undefined)) },
    clock: { now: () => new Date('2026-06-16T00:00:00.000Z') },
  } as unknown as StubbedEraseDeps;
}
