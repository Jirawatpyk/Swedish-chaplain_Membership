/**
 * Deliberate-duplicate guard on the admin "New invoice" path.
 *
 * The rule: a member CAN legitimately hold two live membership invoices in
 * the same plan year — but it must be deliberate, never accidental. So
 * `createInvoiceDraft` REFUSES by default when one already exists, hands the
 * caller enough to show the admin WHAT exists, and proceeds only on an
 * explicit acknowledgement that is recorded in the audit payload.
 *
 * Scope note — `void` exclusion is an ADAPTER predicate (`ne(status,'void')`
 * in `drizzle-invoice-repo.findLiveMembershipBillInTx`), so it cannot be
 * proven here with a stubbed port. It is pinned against live Neon in
 * `tests/integration/invoicing/duplicate-membership-bill-guard.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  createInvoiceDraft,
  createInvoiceDraftSchema,
  type CreateInvoiceDraftDeps,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import type { InvoiceRepo, LiveMembershipBillView } from '@/modules/invoicing/application/ports/invoice-repo';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import type { MemberIdentityView } from '@/modules/invoicing/application/ports/member-identity-port';

const MEMBER_ID = '00000000-0000-0000-0000-00000000aaaa';
const EXISTING_INVOICE_ID = '11111111-1111-1111-1111-111111111111';

/**
 * The existing live bill the guard is expected to find. Issued + numbered +
 * totalled, i.e. the shape that matters most: a real numbered §86/4 the
 * member has already been sent.
 */
const EXISTING_ISSUED_BILL: LiveMembershipBillView = {
  invoiceId: EXISTING_INVOICE_ID,
  status: 'issued',
  documentNumber: 'SC-2026-0042',
  totalSatang: 2140000n,
};

function makeSettings(): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(0n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    brandName: null,
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
  } as TenantInvoiceSettingsView;
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
      member_number: null,
      member_number_display: null,
    },
    ...overrides,
  } as MemberIdentityView;
}

interface Harness {
  readonly deps: CreateInvoiceDraftDeps;
  readonly insertDraft: ReturnType<typeof vi.fn>;
  readonly emit: ReturnType<typeof vi.fn>;
  readonly findLive: ReturnType<typeof vi.fn>;
}

/**
 * Stub params are typed off the REAL port via `Parameters<…>` — an untyped
 * `vi.fn()` infers `any` and would silently absorb an argument-order change
 * without typecheck noticing.
 */
function makeHarness(
  existing: LiveMembershipBillView | null,
  memberOverrides: Partial<MemberIdentityView> = {},
): Harness {
  let uuidCounter = 0;
  const insertDraft = vi.fn(
    async (..._args: Parameters<InvoiceRepo['insertDraft']>): Promise<Invoice> => {
      const args = _args[1];
      return {
        tenantId: args.tenantId,
        invoiceId: asInvoiceId(args.invoiceId),
        memberId: args.memberId,
        planYear: args.planYear,
        status: 'draft',
        lines: args.lines,
      } as unknown as Invoice;
    },
  );
  const emit = vi.fn(async () => {});
  const findLive = vi.fn(
    async (
      ..._args: Parameters<InvoiceRepo['findLiveMembershipBillInTx']>
    ): Promise<LiveMembershipBillView | null> => existing,
  );

  const deps = {
    invoiceRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tag: 'the-tx' })),
      insertDraft,
      findLiveMembershipBillInTx: findLive,
    },
    tenantSettingsRepo: { getForIssue: vi.fn(async () => makeSettings()) },
    memberIdentity: { getForIssue: vi.fn(async () => makeMember(memberOverrides)) },
    planLookup: {
      getAnnualFeeSatang: vi.fn(async () => 2000000n),
      getPlanName: vi.fn(async () => ({ th: 'สมาชิกสามัญ', en: 'Regular Member' })),
    },
    audit: { emit },
    clock: { nowIso: () => '2026-01-15T10:00:00Z' },
    newUuid: () => `${++uuidCounter}-uuid`,
  } as unknown as CreateInvoiceDraftDeps;

  return { deps, insertDraft, emit, findLive };
}

const baseInput = {
  tenantId: 'test-swecham',
  actorUserId: 'admin-user',
  requestId: 'req-1',
  memberId: MEMBER_ID,
  planId: 'regular',
  planYear: 2026,
};

/** What the admin "New invoice" route sends on an ordinary submit. */
const refuseInput = { ...baseInput, duplicatePolicy: 'refuse' as const };

describe('createInvoiceDraft — deliberate-duplicate guard', () => {
  describe('refuse by default', () => {
    it('refuses when the member already holds a live membership bill for the plan year', async () => {
      const h = makeHarness(EXISTING_ISSUED_BILL);

      const result = await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(refuseInput));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('duplicate_membership_invoice');
    });

    it('surfaces the existing document so the admin can make an INFORMED decision', async () => {
      // The whole point of the guard is an informed decision, not a reflexive
      // click-through: a bare "duplicate exists" is not enough. Assert every
      // field the UI needs to render + deep-link the existing invoice.
      const h = makeHarness(EXISTING_ISSUED_BILL);

      const result = await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(refuseInput));

      if (result.ok) throw new Error('expected refusal');
      expect(result.error).toEqual({
        code: 'duplicate_membership_invoice',
        existingInvoiceId: EXISTING_INVOICE_ID,
        existingStatus: 'issued',
        existingDocumentNumber: 'SC-2026-0042',
        existingTotalSatang: 2140000n,
      });
    });

    it('surfaces a DRAFT duplicate with null number/total rather than hiding it', async () => {
      // A draft has no §87 number and no frozen total yet. The guard must
      // still refuse — and report honestly — instead of treating "unnumbered"
      // as "not really a duplicate".
      const h = makeHarness({
        invoiceId: EXISTING_INVOICE_ID,
        status: 'draft',
        documentNumber: null,
        totalSatang: null,
      });

      const result = await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(refuseInput));

      if (result.ok) throw new Error('expected refusal');
      if (result.error.code !== 'duplicate_membership_invoice') throw new Error('wrong code');
      expect(result.error.existingStatus).toBe('draft');
      expect(result.error.existingDocumentNumber).toBeNull();
      expect(result.error.existingTotalSatang).toBeNull();
    });

    it('writes NOTHING on refusal — the guard sits above the first write', async () => {
      // `err(...)` inside a `withTx` callback does NOT throw: the transaction
      // COMMITS. So a guard placed below a write would persist that write and
      // emit a false audit row. Pin the placement, not just the return value.
      const h = makeHarness(EXISTING_ISSUED_BILL);

      await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(refuseInput));

      expect(h.insertDraft).not.toHaveBeenCalled();
      expect(h.emit).not.toHaveBeenCalled();
    });

    it('asks about exactly the (tenant, member, plan_year) it is about to mint, on the caller tx', async () => {
      const h = makeHarness(null);

      await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(refuseInput));

      expect(h.findLive).toHaveBeenCalledWith({ tag: 'the-tx' }, {
        tenantId: 'test-swecham',
        memberId: MEMBER_ID,
        planYear: 2026,
      });
    });
  });

  describe('allow on explicit acknowledgement', () => {
    it('proceeds when the duplicate is explicitly acknowledged', async () => {
      const h = makeHarness(EXISTING_ISSUED_BILL);

      const result = await createInvoiceDraft(
        h.deps,
        createInvoiceDraftSchema.parse({ ...baseInput, duplicatePolicy: 'acknowledged' }),
      );

      expect(result.ok).toBe(true);
      expect(h.insertDraft).toHaveBeenCalledTimes(1);
    });

    it('records WHO overrode and AGAINST WHICH invoice in the audit payload', async () => {
      // "Who deliberately created a duplicate, and against which existing
      // invoice" must be answerable later.
      const h = makeHarness(EXISTING_ISSUED_BILL);

      await createInvoiceDraft(
        h.deps,
        createInvoiceDraftSchema.parse({ ...baseInput, duplicatePolicy: 'acknowledged' }),
      );

      expect(h.emit).toHaveBeenCalledTimes(1);
      const emitted = h.emit.mock.calls[0]![1] as {
        eventType: string;
        actorUserId: string;
        payload: Record<string, unknown>;
      };
      expect(emitted.eventType).toBe('invoice_draft_created');
      expect(emitted.actorUserId).toBe('admin-user');
      expect(emitted.payload.acknowledged_duplicate).toBe(true);
      expect(emitted.payload.acknowledged_duplicate_of_invoice_id).toBe(EXISTING_INVOICE_ID);
    });

    it('marks an ordinary (non-duplicate) draft as NOT an acknowledged duplicate', async () => {
      // The flag must be a positive assertion about THIS draft, not a field
      // that is merely absent — otherwise "no duplicate" and "duplicate we
      // failed to detect" look identical in the audit trail.
      const h = makeHarness(null);

      await createInvoiceDraft(
        h.deps,
        createInvoiceDraftSchema.parse({ ...baseInput, duplicatePolicy: 'acknowledged' }),
      );

      const emitted = h.emit.mock.calls[0]![1] as { payload: Record<string, unknown> };
      expect(emitted.payload.acknowledged_duplicate).toBe(false);
      expect(emitted.payload.acknowledged_duplicate_of_invoice_id).toBeNull();
    });
  });

  describe('the policy cannot be set by accident', () => {
    it.each([
      ['the string "true"', 'true'],
      ['the boolean true', true],
      ['the number 1', 1],
      ['an unknown policy name', 'allow'],
      ['an empty string', ''],
    ])('rejects %s — only the two named policies are accepted', (_label, value) => {
      // Coercion resistance at the WIRE boundary (`acknowledge_duplicate:
      // z.literal(true)`) is pinned in
      // tests/contract/invoices/create-draft-duplicate-ack.contract.test.ts.
      // Here the point is that the internal policy is a closed enum, so a
      // truthy value can never be read as "acknowledged".
      const parsed = createInvoiceDraftSchema.safeParse({
        ...baseInput,
        duplicatePolicy: value,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('callers that did NOT opt in are unaffected', () => {
    it('does not even query when duplicatePolicy is absent', async () => {
      // `createInvoiceDraft` is shared. void-on-reissue
      // (issueMembershipBill / issueInvoiceForRenewal) legitimately drafts a
      // REPLACEMENT bill while the superseded one is still `issued` — voiding
      // the old one is the NEXT step. An always-on guard here would break
      // that shipped path, so an absent policy must skip the check entirely,
      // not merely tolerate a hit.
      const h = makeHarness(EXISTING_ISSUED_BILL);

      const result = await createInvoiceDraft(
        h.deps,
        createInvoiceDraftSchema.parse(baseInput),
      );

      expect(result.ok).toBe(true);
      expect(h.findLive).not.toHaveBeenCalled();
      expect(h.insertDraft).toHaveBeenCalledTimes(1);
    });

    it('records a non-opted-in draft as NOT an acknowledged duplicate', async () => {
      const h = makeHarness(EXISTING_ISSUED_BILL);

      await createInvoiceDraft(h.deps, createInvoiceDraftSchema.parse(baseInput));

      const emitted = h.emit.mock.calls[0]![1] as { payload: Record<string, unknown> };
      expect(emitted.payload.acknowledged_duplicate).toBe(false);
      expect(emitted.payload.acknowledged_duplicate_of_invoice_id).toBeNull();
    });
  });

  describe('the acknowledgement overrides ONLY the duplicate check', () => {
    it('does not let an acknowledged duplicate bill an ARCHIVED member', async () => {
      const h = makeHarness(EXISTING_ISSUED_BILL, { isArchived: true });

      const result = await createInvoiceDraft(
        h.deps,
        createInvoiceDraftSchema.parse({ ...baseInput, duplicatePolicy: 'acknowledged' }),
      );

      if (result.ok) throw new Error('expected refusal');
      expect(result.error.code).toBe('member_archived');
      expect(h.insertDraft).not.toHaveBeenCalled();
    });
  });
});
