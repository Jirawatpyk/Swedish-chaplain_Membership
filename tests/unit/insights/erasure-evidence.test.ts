/**
 * COMP-1 US3-D (Task 3) — `getErasureEvidenceLog` use-case unit tests.
 *
 * The use-case is pure-of-IO through three injected deps (`listErasedMembers`,
 * `listMemberLinkedUserIds`, `evidenceReader`), so we exercise every fold +
 * flag with hand-rolled fakes (no module mocking). It pages the erased-member
 * list, resolves each member's linked-login ids, reads the member's raw
 * erasure-evidence rows, and folds them into the DPO-friendly grouped shape:
 *   - the `member_erasure_requested` attestation (reason + identity_verified +
 *     verification_method + note);
 *   - the `member_erased` cascade counts (or null when absent);
 *   - the `user_erased` proofs as `{ occurredAt, credentialErased }` ONLY —
 *     the row's `actor_user_id` is DELIBERATELY DROPPED (M-2): for a
 *     [structurally-impossible-but-defensive] shared login it could be another
 *     tenant's admin id, so it is minimised OUT of the output shape entirely;
 *   - the `event_buyer_pii_redacted` rows as `{ occurredAt, documentKind }`
 *     (H-1 invoice-vs-credit_note discriminator);
 *   - the `subprocessor_erasure_propagated` outcome + counts;
 *   - `halfRun` (requested present, erased absent) + `isOverdue`
 *     (`requestedAt + 30d < now`, `now` injected so the clock is deterministic).
 */
import { describe, expect, it } from 'vitest';
import {
  getErasureEvidenceLog,
  THIRTY_DAYS_MS,
  type GetErasureEvidenceLogDeps,
} from '@/modules/insights/application/erasure-evidence';
import type { ErasureEvidenceRow } from '@/modules/auth';
import type { ErasedMemberRow } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';

const CTX = { slug: 'tenant-a' } as unknown as TenantContext;

/** A stable `now` — every relative requested-at offset below is from this. */
const NOW = new Date('2026-06-20T00:00:00.000Z');

function isoMinus(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const TEN_MIN_MS = 10 * 60 * 1000;
const FORTY_DAYS_MS = 40 * 24 * 60 * 60 * 1000;

/**
 * Build the three deps from a per-member map of `{ erasedMemberRow, linkedIds,
 * evidenceRows }`. The use-case calls `listErasedMembers(ctx, {limit, cursor})`
 * once for the page, then per member `listMemberLinkedUserIds` + `readForMember`.
 */
function makeDeps(members: {
  rows: ErasedMemberRow[];
  nextCursor?: ErasedMemberRow extends never ? never : unknown;
  linkedByMember: Record<string, readonly string[]>;
  evidenceByMember: Record<string, ErasureEvidenceRow[]>;
}): GetErasureEvidenceLogDeps {
  return {
    listErasedMembers: async () => ({
      rows: members.rows,
      nextCursor: (members.nextCursor as never) ?? null,
    }),
    listMemberLinkedUserIds: async (_ctx, memberId) =>
      members.linkedByMember[memberId as unknown as string] ?? [],
    evidenceReader: {
      readForMember: async (_ctx, memberId) =>
        members.evidenceByMember[memberId] ?? [],
    },
  };
}

function erasedRow(memberId: string, memberNumber: number): ErasedMemberRow {
  return { memberId, memberNumber, erasedAt: new Date(isoMinus(TEN_MIN_MS)) };
}

describe('getErasureEvidenceLog', () => {
  it('folds a COMPLETE erasure: not half-run, not overdue, attestation + cascade counts + lifecycle outcomes', async () => {
    const memberId = 'm-complete';
    const userId = '11111111-1111-1111-1111-111111111111';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 1042)],
      linkedByMember: { [memberId]: [userId] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              identity_verified: true,
              verification_method: 'in_person',
              note: 'verified passport at front desk',
            },
          },
          {
            id: 'ev-erased',
            eventType: 'member_erased',
            occurredAtIso: isoMinus(TEN_MIN_MS - 1000),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              sessions_revoked_total: 3,
              invitations_revoked_count: 1,
              re_drive: false,
            },
          },
          {
            id: 'ev-user',
            eventType: 'user_erased',
            occurredAtIso: isoMinus(TEN_MIN_MS - 500),
            // a DIFFERENT actor — must NOT survive into the output (M-2).
            actorUserId: 'other-tenant-admin-DO-NOT-LEAK',
            targetUserId: userId,
            payload: { user_id: userId },
          },
          {
            id: 'ev-tax-inv',
            eventType: 'event_buyer_pii_redacted',
            occurredAtIso: isoMinus(TEN_MIN_MS - 100),
            actorUserId: 'system:cron',
            targetUserId: null,
            payload: { member_id: memberId, document_kind: 'invoice', redacted_at: isoMinus(0) },
          },
          {
            id: 'ev-tax-cn',
            eventType: 'event_buyer_pii_redacted',
            occurredAtIso: isoMinus(TEN_MIN_MS - 200),
            actorUserId: 'system:cron',
            targetUserId: null,
            payload: { member_id: memberId, document_kind: 'credit_note', redacted_at: isoMinus(0) },
          },
          {
            id: 'ev-sub',
            eventType: 'subprocessor_erasure_propagated',
            occurredAtIso: isoMinus(TEN_MIN_MS - 300),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              resend_outcome: 'ok',
              resend_contacts_removed_count: 2,
              resend_contacts_failed_count: 0,
              stripe_outcome: 'noop',
            },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    expect(out.rows).toHaveLength(1);
    const row = out.rows[0]!;
    expect(row.memberId).toBe(memberId);
    expect(row.memberNumber).toBe(1042);
    // attestation
    expect(row.reason).toBe('gdpr_erasure_request');
    expect(row.requestedAt?.toISOString()).toBe(isoMinus(TEN_MIN_MS));
    expect(row.identityVerified).toBe(true);
    expect(row.verificationMethod).toBe('in_person');
    expect(row.note).toBe('verified passport at front desk');
    // cascade
    expect(row.completedAt?.toISOString()).toBe(isoMinus(TEN_MIN_MS - 1000));
    expect(row.sessionsRevokedTotal).toBe(3);
    expect(row.invitationsRevokedCount).toBe(1);
    // first-pass completion (member_erased.re_drive === false), not a reconciler re-drive
    expect(row.reDrive).toBe(false);
    // user_erased proofs — occurredAt + credentialErased ONLY
    expect(row.userErasedProofs).toHaveLength(1);
    expect(row.userErasedProofs[0]!.occurredAt.toISOString()).toBe(isoMinus(TEN_MIN_MS - 500));
    expect(row.userErasedProofs[0]!.credentialErased).toBe(true);
    // tax redactions — both invoice + credit_note discriminators surfaced (H-1)
    const kinds = row.taxRedactions.map((t) => t.documentKind).sort();
    expect(kinds).toEqual(['credit_note', 'invoice']);
    // subprocessor outcome
    expect(row.subprocessorOutcome).toEqual({
      resendOutcome: 'ok',
      contactsRemoved: 2,
      contactsFailed: 0,
    });
    // flags
    expect(row.halfRun).toBe(false);
    expect(row.isOverdue).toBe(false);
  });

  it('flags a HALF-RUN, FRESH erasure (requested 10 min ago, no member_erased): halfRun true, isOverdue false', async () => {
    const memberId = 'm-fresh';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 7)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'pdpa_deletion_request' },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.halfRun).toBe(true);
    expect(row.isOverdue).toBe(false);
    expect(row.completedAt).toBeNull();
    expect(row.sessionsRevokedTotal).toBeNull();
    expect(row.invitationsRevokedCount).toBeNull();
    // No completion row → re_drive is null (not false), so the page does not
    // show a "completed via reconciler re-drive" note on a half-run.
    expect(row.reDrive).toBeNull();
  });

  it('surfaces reDrive=true when the completion came via a US2d reconciler re-drive (0/0 cascade counts)', async () => {
    const memberId = 'm-redrive';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 314)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
          {
            id: 'ev-erased',
            eventType: 'member_erased',
            occurredAtIso: isoMinus(TEN_MIN_MS - 1000),
            // The reconciler completes the half-failed run; its cascade counts
            // reflect ONLY this pass, so they are 0/0 (the original run already
            // revoked the sessions/invitations). re_drive=true explains the 0/0.
            actorUserId: 'system:erase-reconcile',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              sessions_revoked_total: 0,
              invitations_revoked_count: 0,
              re_drive: true,
            },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.halfRun).toBe(false);
    expect(row.reDrive).toBe(true);
    expect(row.sessionsRevokedTotal).toBe(0);
    expect(row.invitationsRevokedCount).toBe(0);
  });

  it('flags a HALF-RUN, OLD erasure (requested 40 days ago, no member_erased): halfRun true, isOverdue true', async () => {
    const memberId = 'm-old';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 9)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(FORTY_DAYS_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.halfRun).toBe(true);
    expect(row.isOverdue).toBe(true);
  });

  it('M-2: the serialised output carries NO actorUserId anywhere in the user_erased proofs', async () => {
    const memberId = 'm-leak-check';
    const userId = '22222222-2222-2222-2222-222222222222';
    const leakSentinel = 'other-tenant-admin-LEAK-SENTINEL';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 12)],
      linkedByMember: { [memberId]: [userId] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
          {
            id: 'ev-user',
            eventType: 'user_erased',
            occurredAtIso: isoMinus(TEN_MIN_MS - 500),
            actorUserId: leakSentinel,
            targetUserId: userId,
            payload: { user_id: userId, actor_user_id: leakSentinel },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.userErasedProofs).toHaveLength(1);
    // No `actorUserId` key on the proof object.
    expect(Object.prototype.hasOwnProperty.call(row.userErasedProofs[0]!, 'actorUserId')).toBe(false);
    // And the leaked actor id appears NOWHERE in the serialised proof set.
    expect(JSON.stringify(row.userErasedProofs)).not.toContain(leakSentinel);
  });

  it('passes through the member-list nextCursor and reads each erased member', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const deps = makeDeps({
      rows: ids.map((id, i) => erasedRow(id, 100 + i)),
      linkedByMember: {},
      evidenceByMember: {},
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 3, now: NOW });

    expect(out.rows.map((r) => r.memberId)).toEqual(ids);
    // No evidence rows → every fold field is null/empty, not a throw.
    for (const r of out.rows) {
      expect(r.requestedAt).toBeNull();
      expect(r.completedAt).toBeNull();
      expect(r.reDrive).toBeNull();
      expect(r.userErasedProofs).toEqual([]);
      expect(r.taxRedactions).toEqual([]);
      expect(r.subprocessorOutcome).toBeNull();
      expect(r.halfRun).toBe(false);
      expect(r.isOverdue).toBe(false);
    }
  });

  it('exports THIRTY_DAYS_MS as the 30-day PDPA window in milliseconds', () => {
    expect(THIRTY_DAYS_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('EARLIEST-wins: a re-drive double-row surfaces the FIRST-pass subprocessor `failed` + the originating request, NOT a later vacuous `ok` (cross-task US3-C cond-3)', async () => {
    const memberId = 'm-redrive';
    // Rows arrive newest-first (the reader orders timestamp DESC). The member's
    // first-pass Resend removal FAILED; a US2d re-drive later emitted a VACUOUS
    // ok/removed:0. The DPO must see the authoritative `failed`, not the masking
    // `ok`. Likewise the earliest `member_erasure_requested` wins the Art.12 clock.
    const deps = makeDeps({
      rows: [erasedRow(memberId, 2099)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          // NEWEST first: the re-drive's vacuous ok.
          {
            id: 'ev-sub-redrive',
            eventType: 'subprocessor_erasure_propagated',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'system:cron',
            targetUserId: null,
            payload: { member_id: memberId, resend_outcome: 'ok', resend_contacts_removed_count: 0, resend_contacts_failed_count: 0 },
          },
          // The later (newest) duplicate erasure request.
          {
            id: 'ev-req-late',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS + 1000),
            actorUserId: 'admin-2',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'pdpa_deletion_request' },
          },
          // EARLIEST: the first-pass failed propagation.
          {
            id: 'ev-sub-firstpass',
            eventType: 'subprocessor_erasure_propagated',
            occurredAtIso: isoMinus(FORTY_DAYS_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, resend_outcome: 'failed', resend_contacts_removed_count: 0, resend_contacts_failed_count: 2 },
          },
          // EARLIEST request (wins the Art.12 clock → 40 days → overdue).
          {
            id: 'ev-req-first',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(FORTY_DAYS_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
        ],
      },
    });

    const { rows } = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });
    const row = rows[0]!;
    // The first-pass FAILED outcome wins — the page does NOT mask it with the re-drive ok.
    expect(row.subprocessorOutcome).toEqual({ resendOutcome: 'failed', contactsRemoved: 0, contactsFailed: 2 });
    // The earliest request wins the Art.12 clock (40d ago) → overdue (half-run: no member_erased).
    expect(row.requestedAt?.toISOString()).toBe(isoMinus(FORTY_DAYS_MS));
    expect(row.reason).toBe('gdpr_erasure_request');
    expect(row.halfRun).toBe(true);
    expect(row.isOverdue).toBe(true);
  });

  it('folds the `?? unknown` / `?? 0` fallbacks: a tax redaction with no document_kind + a subprocessor row with no resend_outcome', async () => {
    const memberId = 'm-fallbacks';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 808)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
          // event_buyer_pii_redacted with an EMPTY payload → no `document_kind`.
          {
            id: 'ev-tax-bare',
            eventType: 'event_buyer_pii_redacted',
            occurredAtIso: isoMinus(TEN_MIN_MS - 100),
            actorUserId: 'system:cron',
            targetUserId: null,
            payload: {},
          },
          // subprocessor row MISSING resend_outcome + both counts.
          {
            id: 'ev-sub-bare',
            eventType: 'subprocessor_erasure_propagated',
            occurredAtIso: isoMinus(TEN_MIN_MS - 200),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.taxRedactions).toHaveLength(1);
    expect(row.taxRedactions[0]!.documentKind).toBe('unknown');
    expect(row.subprocessorOutcome).toEqual({
      resendOutcome: 'unknown',
      contactsRemoved: 0,
      contactsFailed: 0,
    });
  });

  it('I-1 invariant: a COMPLETED erasure is NEVER overdue, regardless of how old the request is', async () => {
    const memberId = 'm-old-complete';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 55)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          // Requested 40 days ago (would be overdue IF it were a half-run)…
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(FORTY_DAYS_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
          // …but it COMPLETED (member_erased present) → never overdue.
          {
            id: 'ev-erased',
            eventType: 'member_erased',
            occurredAtIso: isoMinus(FORTY_DAYS_MS - 1000),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              sessions_revoked_total: 2,
              invitations_revoked_count: 0,
              re_drive: false,
            },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    expect(row.halfRun).toBe(false);
    expect(row.isOverdue).toBe(false);
    // The invariant: isOverdue ⇒ completedAt === null. Here completedAt is set.
    expect(row.completedAt).not.toBeNull();
  });

  it('FIX-7: dedupes user_erased proofs per distinct linked login — same-login re-drive dups collapse to ONE earliest; distinct logins stay separate', async () => {
    // (A) ONE linked login, FOUR user_erased rows (a US2d reconciler re-drive
    // re-runs eraseUser per pass → eraseUser appends a fresh user_erased each
    // pass, all with the SAME target_user_id) → collapse to ONE proof @ EARLIEST.
    {
      const memberId = 'm-dedupe-one-login';
      const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      // T0 is the earliest; the three re-drive dups are T0+1m, T0+2m, T0+3m.
      // (isoMinus is "now minus ms", so a LARGER ms is OLDER → T0 = isoMinus of
      // the largest offset.)
      const t0 = TEN_MIN_MS;
      const deps = makeDeps({
        rows: [erasedRow(memberId, 5001)],
        linkedByMember: { [memberId]: [userId] },
        evidenceByMember: {
          [memberId]: [
            {
              id: 'ev-req',
              eventType: 'member_erasure_requested',
              occurredAtIso: isoMinus(t0),
              actorUserId: 'admin-1',
              targetUserId: null,
              payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
            },
            {
              id: 'ev-user-0',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(t0), // EARLIEST
              actorUserId: 'admin-1',
              targetUserId: userId,
              payload: { user_id: userId },
            },
            {
              id: 'ev-user-1',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(t0 - 1 * 60 * 1000), // T0 + 1m
              actorUserId: 'system:erase-reconcile',
              targetUserId: userId,
              payload: { user_id: userId },
            },
            {
              id: 'ev-user-2',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(t0 - 2 * 60 * 1000), // T0 + 2m
              actorUserId: 'system:erase-reconcile',
              targetUserId: userId,
              payload: { user_id: userId },
            },
            {
              id: 'ev-user-3',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(t0 - 3 * 60 * 1000), // T0 + 3m
              actorUserId: 'system:erase-reconcile',
              targetUserId: userId,
              payload: { user_id: userId },
            },
          ],
        },
      });

      const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });
      const row = out.rows[0]!;
      // Four same-login re-drive rows collapse to ONE proof…
      expect(row.userErasedProofs).toHaveLength(1);
      // …kept at the EARLIEST occurredAt (the Art.12/§30 credential-erasure clock).
      expect(row.userErasedProofs[0]!.occurredAt.toISOString()).toBe(isoMinus(t0));
      expect(row.userErasedProofs[0]!.credentialErased).toBe(true);
    }

    // (B) TWO DISTINCT linked logins, each with TWO user_erased rows → TWO proofs,
    // each at its own login's earliest (distinct logins are NOT collapsed).
    {
      const memberId = 'm-dedupe-two-logins';
      const uA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const uB = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const aEarliest = TEN_MIN_MS; // uA's earliest
      const bEarliest = TEN_MIN_MS - 5 * 60 * 1000; // uB's earliest (newer than uA)
      const deps = makeDeps({
        rows: [erasedRow(memberId, 5002)],
        linkedByMember: { [memberId]: [uA, uB] },
        evidenceByMember: {
          [memberId]: [
            {
              id: 'ev-user-a0',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(aEarliest), // uA earliest
              actorUserId: 'admin-1',
              targetUserId: uA,
              payload: { user_id: uA },
            },
            {
              id: 'ev-user-a1',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(aEarliest - 1 * 60 * 1000), // uA re-drive dup
              actorUserId: 'system:erase-reconcile',
              targetUserId: uA,
              payload: { user_id: uA },
            },
            {
              id: 'ev-user-b0',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(bEarliest), // uB earliest
              actorUserId: 'admin-1',
              targetUserId: uB,
              payload: { user_id: uB },
            },
            {
              id: 'ev-user-b1',
              eventType: 'user_erased',
              occurredAtIso: isoMinus(bEarliest - 1 * 60 * 1000), // uB re-drive dup
              actorUserId: 'system:erase-reconcile',
              targetUserId: uB,
              payload: { user_id: uB },
            },
          ],
        },
      });

      const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });
      const row = out.rows[0]!;
      // Two DISTINCT logins → two proofs (NOT folded onto a single global earliest).
      expect(row.userErasedProofs).toHaveLength(2);
      const proofIsos = row.userErasedProofs.map((p) => p.occurredAt.toISOString()).sort();
      // Each proof is its own login's EARLIEST.
      expect(proofIsos).toEqual([isoMinus(aEarliest), isoMinus(bEarliest)].sort());
    }
  });

  it('S-3 EARLIEST-wins on a DOUBLE member_erased: the first-pass real counts win, not a later racing re-drive 0/0', async () => {
    const memberId = 'm-double-erased';
    const deps = makeDeps({
      rows: [erasedRow(memberId, 4242)],
      linkedByMember: { [memberId]: [] },
      evidenceByMember: {
        [memberId]: [
          // NEWEST first (the reader orders DESC): a later racing reconciler
          // re-drive completion — vacuous 0/0, re_drive:true.
          {
            id: 'ev-erased-redrive',
            eventType: 'member_erased',
            occurredAtIso: isoMinus(TEN_MIN_MS),
            actorUserId: 'system:erase-reconcile',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              sessions_revoked_total: 0,
              invitations_revoked_count: 0,
              re_drive: true,
            },
          },
          {
            id: 'ev-req',
            eventType: 'member_erasure_requested',
            occurredAtIso: isoMinus(FORTY_DAYS_MS),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: { member_id: memberId, reason: 'gdpr_erasure_request' },
          },
          // EARLIEST member_erased: the first-pass completion with REAL counts.
          {
            id: 'ev-erased-firstpass',
            eventType: 'member_erased',
            occurredAtIso: isoMinus(FORTY_DAYS_MS - 1000),
            actorUserId: 'admin-1',
            targetUserId: null,
            payload: {
              member_id: memberId,
              reason: 'gdpr_erasure_request',
              sessions_revoked_total: 3,
              invitations_revoked_count: 1,
              re_drive: false,
            },
          },
        ],
      },
    });

    const out = await getErasureEvidenceLog(deps, { ctx: CTX, limit: 10, now: NOW });

    const row = out.rows[0]!;
    // The first-pass real counts win — NOT the later racing 0/0 re-drive.
    expect(row.sessionsRevokedTotal).toBe(3);
    expect(row.invitationsRevokedCount).toBe(1);
    expect(row.reDrive).toBe(false);
    expect(row.completedAt?.toISOString()).toBe(isoMinus(FORTY_DAYS_MS - 1000));
    expect(row.halfRun).toBe(false);
    expect(row.isOverdue).toBe(false);
  });
});
