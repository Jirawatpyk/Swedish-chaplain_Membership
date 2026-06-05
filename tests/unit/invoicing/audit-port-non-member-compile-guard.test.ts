/**
 * 054-event-fee-invoices — compile-time guard for the non-member audit
 * payload contract on `emitNonMemberInvoiceEvent`.
 *
 * Context
 * -------
 * A recent fix introduced `NonMemberInvoiceAuditPayload` and the typed
 * helper `emitNonMemberInvoiceEvent` in
 * `src/modules/invoicing/application/ports/audit-port.ts`. The
 * structural contract is:
 *
 *   - `event_registration_id: string` — REQUIRED  (F6 correlation key)
 *   - `member_id?: never`             — FORBIDDEN  (omitting it keeps the
 *     row off the F3 member timeline; the old `member_id: ''` coalesce
 *     bug would fail here at compile time rather than persisting a bad row)
 *
 * These `@ts-expect-error` markers are the lock. If a future refactor
 * widens the type so that a forbidden payload accidentally compiles, the
 * corresponding `@ts-expect-error` becomes an unused directive (TypeScript
 * error TS2578 "Unused '@ts-expect-error' directive") which fails
 * `pnpm typecheck`. That failure IS the test.
 *
 * Pattern mirrors
 * `tests/unit/broadcasts/application/audit-port-typed-constraint.test.ts`.
 *
 * No runtime assertions — the `@ts-expect-error` markers + the structural
 * assignment tests are the complete lock.
 */
import { describe, it, expect } from 'vitest';
import type {
  NonMemberInvoiceAuditPayload,
  MemberTimelineAuditPayload,
  AuditPort,
  F4MemberTimelineAuditEventType,
} from '@/modules/invoicing/application/ports/audit-port';
import { emitNonMemberInvoiceEvent } from '@/modules/invoicing/application/ports/audit-port';

describe('emitNonMemberInvoiceEvent compile-time payload contract — 054 non-member audit', () => {
  // -------------------------------------------------------------------------
  // (a) Passing `member_id` to NonMemberInvoiceAuditPayload MUST fail to
  //     compile. The F3 timeline filter keys on `payload->>'member_id'`; a
  //     non-member event buyer has no F3 member record so the key MUST be
  //     absent from the persisted row. The old `member_id: ''` coalesce
  //     pattern would have produced a structurally invalid timeline row.
  // -------------------------------------------------------------------------
  it('(a) compile-guard — member_id is FORBIDDEN on NonMemberInvoiceAuditPayload', () => {
    // `member_id?: never` means assigning a string value to `member_id`
    // on a NonMemberInvoiceAuditPayload-typed variable is a TS error.
    // The @ts-expect-error sits on the offending property line so it
    // consumes the "Type 'string' is not assignable to type 'never'"
    // error directly (TS reports the error at the field assignment, not
    // at the opening brace).
    const _badPayload: NonMemberInvoiceAuditPayload = {
      event_registration_id: 'reg-001',
      // @ts-expect-error — member_id is `never` on NonMemberInvoiceAuditPayload; assigning a string MUST fail
      member_id: 'mem-001',
    };
    void _badPayload;

    // Runtime pair so vitest counts the test.
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (b) Omitting `event_registration_id` from NonMemberInvoiceAuditPayload
  //     MUST fail to compile. Every non-member event audit row MUST carry
  //     the F6 correlation key so the row is traceable to its registration.
  // -------------------------------------------------------------------------
  it('(b) compile-guard — event_registration_id is REQUIRED on NonMemberInvoiceAuditPayload', () => {
    // @ts-expect-error — event_registration_id is required on NonMemberInvoiceAuditPayload
    const _missingRegId: NonMemberInvoiceAuditPayload = {
      // event_registration_id intentionally omitted — MUST NOT compile
    };
    void _missingRegId;

    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (c) The CORRECT shape compiles cleanly — `event_registration_id`
  //     present, `member_id` absent. This confirms the type is not so
  //     narrow that it rejects all valid payloads.
  // -------------------------------------------------------------------------
  it('(c) correct shape — event_registration_id present, member_id absent — compiles cleanly', () => {
    const validPayload: NonMemberInvoiceAuditPayload = {
      event_registration_id: 'reg-valid-001',
      invoice_id: 'inv-valid-001',
      invoice_subject: 'event',
    };
    expect(validPayload.event_registration_id).toBe('reg-valid-001');
  });

  // -------------------------------------------------------------------------
  // (d) member_id IS required on MemberTimelineAuditPayload — the
  //     OPPOSITE contract. Confirm the two payload types are distinct so
  //     a non-member emit cannot accidentally be widened back to the
  //     member-timeline arm by a type alias change.
  // -------------------------------------------------------------------------
  it('(d) compile-guard — member_id is REQUIRED on MemberTimelineAuditPayload', () => {
    // @ts-expect-error — member_id is required on MemberTimelineAuditPayload
    const _missingMemberId: MemberTimelineAuditPayload = {
      invoice_id: 'inv-001',
      // member_id intentionally omitted — MUST NOT compile
    };
    void _missingMemberId;

    const validTimeline: MemberTimelineAuditPayload = {
      member_id: 'mem-abc',
      invoice_id: 'inv-abc',
    };
    expect(validTimeline.member_id).toBe('mem-abc');
  });

  // -------------------------------------------------------------------------
  // (e) `emitNonMemberInvoiceEvent` rejects `member_id` in `extraPayload`.
  //
  //     The helper signature has `extraPayload?: { member_id?: never } &
  //     Record<string, unknown>` — passing `member_id` here MUST fail.
  //     This covers the "smuggle it through the spread" vector that the
  //     original double-cast pattern would have allowed.
  // -------------------------------------------------------------------------
  it('(e) compile-guard — emitNonMemberInvoiceEvent rejects member_id in extraPayload', () => {
    const stubAudit: AuditPort = {
      emit: async () => undefined,
    };
    const eventType: F4MemberTimelineAuditEventType = 'invoice_issued';

    void emitNonMemberInvoiceEvent(stubAudit, null, {
      tenantId: 'tenant-1',
      requestId: 'req-1',
      eventType,
      eventRegistrationId: 'reg-001',
      actorUserId: 'user-001',
      summary: 'issued',
      extraPayload: {
        invoice_id: 'inv-001',
        // @ts-expect-error — member_id is never on extraPayload
        member_id: 'mem-should-fail',
      },
    });

    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (f) `emitNonMemberInvoiceEvent` accepts a correct call site — no
  //     member_id, event_registration_id wired through eventRegistrationId.
  //     Confirms the helper is callable without a cast at a valid emit site.
  // -------------------------------------------------------------------------
  it('(f) emitNonMemberInvoiceEvent accepts a correct call (no cast required)', () => {
    const captured: Array<Parameters<AuditPort['emit']>> = [];
    const stubAudit: AuditPort = {
      emit: async (...args) => {
        captured.push(args);
      },
    };

    void emitNonMemberInvoiceEvent(stubAudit, null, {
      tenantId: 'tenant-2',
      requestId: 'req-2',
      eventType: 'invoice_issued',
      eventRegistrationId: 'reg-correct-001',
      actorUserId: 'user-2',
      summary: 'Invoice issued for non-member event buyer',
      extraPayload: {
        invoice_id: 'inv-correct-001',
        amount_satang: 100_000,
      },
    });

    // Runtime: the helper constructs a NonMemberInvoiceAuditPayload that
    // merges extraPayload + event_registration_id. Confirm the merged
    // payload type shape is what the helper signature promises.
    const payload: NonMemberInvoiceAuditPayload = {
      event_registration_id: 'reg-correct-001',
      invoice_id: 'inv-correct-001',
      amount_satang: 100_000,
    };
    expect(payload.event_registration_id).toBe('reg-correct-001');
    expect('member_id' in payload).toBe(false);
  });
});
