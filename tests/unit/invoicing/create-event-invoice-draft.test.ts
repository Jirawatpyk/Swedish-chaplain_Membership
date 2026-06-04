/**
 * create-event-invoice-draft (054-event-fee-invoices, Task 6b) — Model B
 * VAT-inclusive event-fee draft for member + non-member buyers.
 *
 * Mock-only unit suite: stubs the 3 lookup ports (event-registration,
 * event-details, member-identity) + audit + invoiceRepo.withTx/insertDraft.
 * Covers EVERY error branch of `CreateEventInvoiceDraftError` + 2 happy paths
 * (matched member → memberId set, snapshot null/pinned-at-issue; non-member →
 * memberId null, buyerSnapshot pinned at draft, event_fee line = inclusive).
 *
 * Model B invariant (do-NOT-split-at-draft): the `event_fee` line `unitPrice`
 * MUST equal the inclusive satang (amountOverride OR ticketPriceThb × 100); the
 * invoice subtotal/vat/total stay null at draft (asserted via the insertDraft
 * call shape — the use-case never computes them).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  createEventInvoiceDraft,
  type CreateEventInvoiceDraftDeps,
  type CreateEventInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { EventRegistrationView } from '@/modules/invoicing/application/ports/event-registration-lookup-port';
import type { EventDetailsView } from '@/modules/invoicing/application/ports/event-details-lookup-port';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';

const TENANT = 'test-swecham';
const REG_ID = '00000000-0000-0000-0000-0000000000re';
const EVENT_ID = '00000000-0000-0000-0000-0000000000ev';
const MEMBER_ID = '00000000-0000-0000-0000-00000000aaaa';

function makeRegistration(overrides: Partial<EventRegistrationView> = {}): EventRegistrationView {
  return {
    registrationId: REG_ID,
    eventId: EVENT_ID,
    attendeeName: 'Gala Guest',
    attendeeEmail: 'gala.guest@alpha.example',
    attendeeCompany: 'Alpha Trading Co',
    ticketPriceThb: 3500, // integer THB → × 100 = 350000 satang inclusive
    paymentStatus: 'paid',
    matchType: 'non_member',
    matchedMemberId: null,
    pseudonymised: false,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventDetailsView> = {}): EventDetailsView {
  return {
    eventId: EVENT_ID,
    name: 'Annual Gala',
    startDateIso: '2026-09-10T11:00:00Z',
    ...overrides,
  };
}

function makeMember(overrides: Partial<MemberIdentityView> = {}): MemberIdentityView {
  return {
    memberId: MEMBER_ID,
    isActive: true,
    isArchived: false,
    memberTypeScope: 'company',
    registrationDate: '2024-06-01',
    registrationFeePaid: true,
    snapshot: {
      legal_name: 'Acme Co',
      tax_id: '1234567890123',
      address: 'TH',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
    },
    ...overrides,
  };
}

interface MakeDepsOptions {
  registration?: { kind: 'ok'; value: EventRegistrationView | null } | { kind: 'err' };
  event?: { kind: 'ok'; value: EventDetailsView | null } | { kind: 'err' };
  member?: MemberIdentityView | null;
}

function makeDeps(opts: MakeDepsOptions = {}): CreateEventInvoiceDraftDeps & {
  _insertDraftCalls: () => Array<Record<string, unknown>>;
} {
  let uuidCounter = 0;
  const insertDraftCalls: Array<Record<string, unknown>> = [];

  const regResult = opts.registration ?? {
    kind: 'ok' as const,
    value: makeRegistration(),
  };
  const eventResult = opts.event ?? {
    kind: 'ok' as const,
    value: makeEvent(),
  };
  const member = opts.member === undefined ? null : opts.member;

  const deps = {
    invoiceRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      insertDraft: vi.fn(async (_tx: unknown, args: Record<string, unknown>) => {
        insertDraftCalls.push(args);
        return {
          tenantId: args.tenantId,
          invoiceId: asInvoiceId(args.invoiceId as string),
          memberId: args.memberId ?? null,
          planId: args.planId ?? null,
          planYear: args.planYear ?? null,
          invoiceSubject: args.invoiceSubject,
          vatInclusive: args.vatInclusive,
          eventId: args.eventId ?? null,
          eventRegistrationId: args.eventRegistrationId ?? null,
          status: 'draft',
          draftByUserId: args.draftByUserId,
          fiscalYear: null,
          sequenceNumber: null,
          documentNumber: null,
          issueDate: null,
          dueDate: null,
          paidAt: null,
          voidedAt: null,
          currency: 'THB',
          subtotal: null,
          vatRate: null,
          vat: null,
          total: null,
          creditedTotal: Money.zero(),
          proRatePolicy: null,
          netDays: null,
          tenantIdentitySnapshot: null,
          memberIdentitySnapshot: (args.memberIdentitySnapshot as unknown) ?? null,
          paymentMethod: null,
          paymentReference: null,
          paymentNotes: null,
          paymentRecordedByUserId: null,
          paymentDate: null,
          voidReason: null,
          voidedByUserId: null,
          autoEmailOnIssue: args.autoEmailOnIssue ?? null,
          pdf: null,
          receiptPdf: null,
          receiptPdfStatus: null,
          receiptPdfRenderAttempts: 0,
          receiptPdfLastError: null,
          receiptDocumentNumberRaw: null,
          lines: args.lines,
          createdAt: '2026-06-04T00:00:00Z',
          updatedAt: '2026-06-04T00:00:00Z',
        } as unknown as Invoice;
      }),
    },
    eventRegistrationLookup: {
      findById: vi.fn(async () =>
        regResult.kind === 'err' ? err({ kind: 'lookup_failed' as const }) : ok(regResult.value),
      ),
    },
    eventDetailsLookup: {
      findById: vi.fn(async () =>
        eventResult.kind === 'err'
          ? err({ kind: 'lookup_failed' as const })
          : ok(eventResult.value),
      ),
    },
    memberIdentity: {
      getForIssue: vi.fn(async () => member),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    audit: { emit: vi.fn(async () => {}) },
    newUuid: () => `0000000${++uuidCounter}-0000-0000-0000-00000000line`,
  } as unknown as CreateEventInvoiceDraftDeps;

  return Object.assign(deps, {
    _insertDraftCalls: () => insertDraftCalls,
  });
}

const baseInput: CreateEventInvoiceDraftInput = {
  tenantId: TENANT,
  actorUserId: 'admin-user',
  requestId: 'req-1',
  eventRegistrationId: REG_ID,
};

const nonMemberBuyer = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
};

describe('createEventInvoiceDraft — Model B inclusive line + member/non-member buyer', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('happy paths', () => {
    it('non-member: memberId null, buyerSnapshot pinned at draft, event_fee line = ticketPriceThb × 100 inclusive', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, {
        ...baseInput,
        buyer: nonMemberBuyer,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);

      const call = deps._insertDraftCalls()[0]!;
      expect(call.invoiceSubject).toBe('event');
      expect(call.vatInclusive).toBe(true);
      expect(call.memberId).toBeNull();
      expect(call.planId).toBeNull();
      expect(call.planYear).toBeNull();
      expect(call.eventId).toBe(EVENT_ID);
      expect(call.eventRegistrationId).toBe(REG_ID);
      // Non-member buyer snapshot MUST be pinned at draft.
      expect(call.memberIdentitySnapshot).toEqual({
        legal_name: 'Beta Imports Ltd',
        tax_id: '9876543210123',
        address: '50 Sukhumvit Road, Bangkok 10110',
        primary_contact_name: 'Jane Doe',
        primary_contact_email: 'jane@beta.example',
      });
      // Model B — single event_fee line holds the VAT-INCLUSIVE total.
      const lines = call.lines as Invoice['lines'];
      expect(lines).toHaveLength(1);
      expect(lines[0]!.kind).toBe('event_fee');
      expect(lines[0]!.unitPrice.satang).toBe(350000n); // 3500 THB × 100
      expect(lines[0]!.total.satang).toBe(350000n); // qty 1, no pro-rate
      expect(lines[0]!.proRateFactor).toBeNull();
      // Use-case must NOT split VAT at draft — subtotal/vat/total stay null.
      expect(r.value.subtotal).toBeNull();
      expect(r.value.vat).toBeNull();
      expect(r.value.total).toBeNull();
      // CE date in description (no BE).
      expect(lines[0]!.descriptionEn).toContain('2026-09-10');
      expect(lines[0]!.descriptionEn).toContain('Annual Gala');
      expect(lines[0]!.descriptionTh).toContain('2026-09-10');
    });

    it('non-member: tax_id absent (null) → snapshot tax_id null, still ok', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, {
        ...baseInput,
        buyer: { ...nonMemberBuyer, tax_id: null },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      const call = deps._insertDraftCalls()[0]!;
      expect((call.memberIdentitySnapshot as { tax_id: unknown }).tax_id).toBeNull();
    });

    it('matched member: memberId set, buyerSnapshot null (pinned at issue)', async () => {
      const deps = makeDeps({
        registration: {
          kind: 'ok',
          value: makeRegistration({ matchedMemberId: MEMBER_ID, matchType: 'member' }),
        },
        member: makeMember(),
      });
      const r = await createEventInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);

      const call = deps._insertDraftCalls()[0]!;
      expect(call.memberId).toBe(MEMBER_ID);
      expect(call.invoiceSubject).toBe('event');
      expect(call.vatInclusive).toBe(true);
      // Matched member buyer is re-read + snapshotted at ISSUE → null at draft.
      expect(call.memberIdentitySnapshot ?? null).toBeNull();
      const lines = call.lines as Invoice['lines'];
      expect(lines[0]!.unitPrice.satang).toBe(350000n);
    });

    it('amountOverride takes precedence over ticketPriceThb', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, {
        ...baseInput,
        buyer: nonMemberBuyer,
        amountOverride: 107000, // 1,070.00 THB inclusive
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      const lines = deps._insertDraftCalls()[0]!.lines as Invoice['lines'];
      expect(lines[0]!.unitPrice.satang).toBe(107000n);
    });

    it('emits invoice_draft_created with invoice_subject=event + event_registration_id (non-member → non-timeline payload, no member_id)', async () => {
      const deps = makeDeps();
      await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(deps.audit.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'invoice_draft_created',
          payload: expect.objectContaining({
            event_registration_id: REG_ID,
            event_id: EVENT_ID,
            invoice_subject: 'event',
          }),
        }),
      );
      const payload = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[1].eventType === 'invoice_draft_created',
      )![1].payload as Record<string, unknown>;
      expect(payload.member_id).toBeUndefined();
    });

    it('matched member emits invoice_draft_created WITH member_id (timeline payload)', async () => {
      const deps = makeDeps({
        registration: {
          kind: 'ok',
          value: makeRegistration({ matchedMemberId: MEMBER_ID, matchType: 'member' }),
        },
        member: makeMember(),
      });
      await createEventInvoiceDraft(deps, baseInput);
      const payload = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[1].eventType === 'invoice_draft_created',
      )![1].payload as Record<string, unknown>;
      expect(payload.member_id).toBe(MEMBER_ID);
      expect(payload.invoice_subject).toBe('event');
    });
  });

  describe('error branches', () => {
    it('lookup_failed — registration lookup errors', async () => {
      const deps = makeDeps({ registration: { kind: 'err' } });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('lookup_failed');
    });

    it('registration_not_found + registration_cross_tenant_probe audit on ok(null)', async () => {
      const deps = makeDeps({ registration: { kind: 'ok', value: null } });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('registration_not_found');
      expect(deps.audit.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'registration_cross_tenant_probe',
          payload: expect.objectContaining({ event_registration_id: REG_ID }),
        }),
      );
      // No invoice persisted on a probe.
      expect(deps.invoiceRepo.insertDraft).not.toHaveBeenCalled();
    });

    it('attendee_erased — pseudonymised registration', async () => {
      const deps = makeDeps({
        registration: { kind: 'ok', value: makeRegistration({ pseudonymised: true }) },
      });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('attendee_erased');
    });

    it('no_fee_free_event — ticketPriceThb null and no override', async () => {
      const deps = makeDeps({
        registration: { kind: 'ok', value: makeRegistration({ ticketPriceThb: null }) },
      });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('no_fee_free_event');
    });

    it('no_fee_free_event — ticketPriceThb 0 (comp/free) and no override', async () => {
      const deps = makeDeps({
        registration: { kind: 'ok', value: makeRegistration({ ticketPriceThb: 0 }) },
      });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('no_fee_free_event');
    });

    it('invalid_amount — defensive: ticketPriceThb derives a satang > MAX', async () => {
      // 1,000,001 THB × 100 = 100,000,100 satang > MAX_EVENT_INVOICE_SATANG.
      const deps = makeDeps({
        registration: { kind: 'ok', value: makeRegistration({ ticketPriceThb: 1_000_001 }) },
      });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_amount');
    });

    it('event_not_found — event-details lookup returns ok(null)', async () => {
      const deps = makeDeps({ event: { kind: 'ok', value: null } });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('event_not_found');
    });

    it('lookup_failed — event-details lookup errors', async () => {
      const deps = makeDeps({ event: { kind: 'err' } });
      const r = await createEventInvoiceDraft(deps, { ...baseInput, buyer: nonMemberBuyer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('lookup_failed');
    });

    it('buyer_required — non-member with no buyer object', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, baseInput); // no buyer
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('buyer_required');
    });

    it('invalid_tax_id_format — non-member buyer tax_id not 13 digits', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, {
        ...baseInput,
        buyer: { ...nonMemberBuyer, tax_id: '123' },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_tax_id_format');
    });

    it('invalid_buyer_snapshot — makeMemberIdentitySnapshot throws (empty address)', async () => {
      const deps = makeDeps();
      const r = await createEventInvoiceDraft(deps, {
        ...baseInput,
        buyer: { ...nonMemberBuyer, address: '' },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_buyer_snapshot');
    });

    it('matched company member with null tax_id → succeeds as a draft (054 Task 9 — events do NOT block on missing TIN; issued later as a §105 receipt)', async () => {
      // Per the §86/4 doc-type model, a TIN-less EVENT buyer is NOT blocked at
      // draft — issue-invoice resolves it to a ใบเสร็จรับเงิน (receipt) because
      // the ticket was already paid. The old matched-company-null-tax_id gate
      // was removed from create-event-invoice-draft (it only governs MEMBERSHIP
      // invoices, where issue-invoice still enforces a buyer TIN). A matched
      // company member with no TIN is a rare data anomaly that now yields a
      // receipt rather than blocking.
      const deps = makeDeps({
        registration: {
          kind: 'ok',
          value: makeRegistration({ matchedMemberId: MEMBER_ID, matchType: 'member' }),
        },
        member: makeMember({
          memberTypeScope: 'company',
          snapshot: {
            legal_name: 'Acme Co',
            tax_id: null,
            address: 'TH',
            primary_contact_name: 'John',
            primary_contact_email: 'john@acme.example',
          },
        }),
      });
      const r = await createEventInvoiceDraft(deps, baseInput);
      expect(r.ok, r.ok ? 'ok' : `unexpected err: ${r.error.code}`).toBe(true);
      if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
      // The draft is a matched-member event draft — memberId set, snapshot
      // pinned at issue (null at draft).
      const call = deps._insertDraftCalls()[0]!;
      expect(call.memberId).toBe(MEMBER_ID);
      expect(call.invoiceSubject).toBe('event');
    });

    it('member_not_found — matched member id but member row absent (treated as registration_not_found path? no — member_not_found)', async () => {
      const deps = makeDeps({
        registration: {
          kind: 'ok',
          value: makeRegistration({ matchedMemberId: MEMBER_ID, matchType: 'member' }),
        },
        member: null,
      });
      const r = await createEventInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(false);
      // matched member must resolve; absent → registration_not_found per task union has no member_not_found.
      // The union lists no member_not_found → use-case maps absent matched member to registration_not_found.
      if (!r.ok) expect(r.error.code).toBe('registration_not_found');
    });

    it('individual matched member with null tax_id → NOT gated (ok)', async () => {
      const deps = makeDeps({
        registration: {
          kind: 'ok',
          value: makeRegistration({ matchedMemberId: MEMBER_ID, matchType: 'member' }),
        },
        member: makeMember({
          memberTypeScope: 'individual',
          snapshot: {
            legal_name: 'Jane Person',
            tax_id: null,
            address: 'TH',
            primary_contact_name: 'Jane',
            primary_contact_email: 'jane@person.example',
          },
        }),
      });
      const r = await createEventInvoiceDraft(deps, baseInput);
      expect(r.ok).toBe(true);
    });
  });
});
