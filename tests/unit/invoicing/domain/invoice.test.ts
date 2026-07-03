/**
 * F4 Domain — Invoice aggregate unit tests.
 *
 * Covers all 5 runtime exports from `invoice.ts`:
 *   - parseInvoiceId         — UUID validator
 *   - asInvoiceId            — trusted brand cast (1 trivial case)
 *   - isTerminal             — 6 status values
 *   - enforceOneSubjectLine('membership', …) — 0/1/many membership_fee lines
 *     (replaces the removed `enforceOneMembershipLine` delegate; Task 7)
 *   - assertSnapshotsSet     — 5 missing-field branches + happy
 *   - canTransition          — full transition table per data-model.md § 3.1
 *
 * Authored 2026-05-17 (Phase B of F4 Domain coverage push).
 */
import { describe, it, expect } from 'vitest';
import {
  parseInvoiceId,
  asInvoiceId,
  isTerminal,
  enforceOneSubjectLine,
  assertSnapshotsSet,
  canTransition,
  displayDocumentNumber,
  issuedInvoiceIdentity,
  INVOICE_STATUSES,
  type Invoice,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('INVOICE_STATUSES — exhaustive enum (data-model.md § 3.1)', () => {
  it('contains exactly 6 statuses', () => {
    expect(INVOICE_STATUSES).toHaveLength(6);
  });

  it('includes all canonical states', () => {
    const expected: ReadonlyArray<InvoiceStatus> = [
      'draft',
      'issued',
      'paid',
      'void',
      'credited',
      'partially_credited',
    ];
    for (const s of expected) {
      expect(INVOICE_STATUSES).toContain(s);
    }
  });
});

describe('parseInvoiceId — UUID validate-and-brand', () => {
  it('returns ok for a canonical UUID', () => {
    const r = parseInvoiceId(VALID_UUID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_UUID);
  });

  it('returns ok for an uppercase UUID (case-insensitive)', () => {
    const r = parseInvoiceId(VALID_UUID.toUpperCase());
    expect(r.ok).toBe(true);
  });

  it('returns err for empty string', () => {
    const r = parseInvoiceId('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_invoice_id');
      expect(r.error.raw).toBe('');
    }
  });

  it('returns err for a non-UUID', () => {
    const r = parseInvoiceId('not-a-uuid');
    expect(r.ok).toBe(false);
  });

  it('returns err for non-string (typeof guard)', () => {
    const r = parseInvoiceId(undefined as unknown as string);
    expect(r.ok).toBe(false);
  });

  it('returns err for null', () => {
    const r = parseInvoiceId(null as unknown as string);
    expect(r.ok).toBe(false);
  });
});

describe('asInvoiceId — trusted brand cast', () => {
  it('does NOT validate (trusted contexts only)', () => {
    expect(asInvoiceId('trusted-id')).toBe('trusted-id');
  });
});

describe('displayDocumentNumber — printed §87/§105 number for display (064 remediation A1)', () => {
  const docNum = (raw: string): DocumentNumber => {
    const r = DocumentNumber.parse(raw);
    if (!r.ok) throw new Error('bad fixture doc number');
    return r.value;
  };

  it('prefers the invoice document number when present', () => {
    expect(
      displayDocumentNumber({
        documentNumber: docNum('INV-2026-000001'),
        receiptDocumentNumberRaw: null,
      }),
    ).toBe('INV-2026-000001');
  });

  it('invoice number wins even when a separate receipt number also exists (paid separate-mode row)', () => {
    expect(
      displayDocumentNumber({
        documentNumber: docNum('INV-2026-000001'),
        receiptDocumentNumberRaw: 'RC-2026-000009',
      }),
    ).toBe('INV-2026-000001');
  });

  it('β as-paid no-TIN row (NULL docnum) falls back to the printed §105 receipt number', () => {
    expect(
      displayDocumentNumber({
        documentNumber: null,
        receiptDocumentNumberRaw: 'RC-2026-000777',
      }),
    ).toBe('RC-2026-000777');
  });

  it('returns null only when BOTH numbers are absent (true draft)', () => {
    expect(
      displayDocumentNumber({ documentNumber: null, receiptDocumentNumberRaw: null }),
    ).toBeNull();
  });
});

describe('issuedInvoiceIdentity — void/confirm identity of an ISSUED invoice (088 FR-017)', () => {
  const docNum = (raw: string): DocumentNumber => {
    const r = DocumentNumber.parse(raw);
    if (!r.ok) throw new Error('bad fixture doc number');
    return r.value;
  };

  it('issued 088 bill (NULL §87 docnum) resolves the non-§87 ใบแจ้งหนี้ bill number', () => {
    // Locks: an issued 088 bill is voidable — the guard does NOT 404 it.
    expect(
      issuedInvoiceIdentity({
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000003',
      }),
    ).toBe('SC-2026-000003');
  });

  it('legacy issued row prefers the §87 document number', () => {
    expect(
      issuedInvoiceIdentity({
        documentNumber: docNum('IN-2026-000009'),
        billDocumentNumberRaw: null,
      }),
    ).toBe('IN-2026-000009');
  });

  it('§87 document number wins even if a bill number is somehow also present', () => {
    // Defensive: the §87-at-issue and 088-bill flows are disjoint, but the
    // documentNumber-first order must hold if both are ever set on one row.
    expect(
      issuedInvoiceIdentity({
        documentNumber: docNum('IN-2026-000009'),
        billDocumentNumberRaw: 'SC-2026-000003',
      }),
    ).toBe('IN-2026-000009');
  });

  it('returns null when neither number is present (draft/corrupt row)', () => {
    expect(
      issuedInvoiceIdentity({ documentNumber: null, billDocumentNumberRaw: null }),
    ).toBeNull();
  });

  it('does NOT read the RC receipt number (distinct from displayDocumentNumber)', () => {
    // The void guard acts on the pre-payment bill, so a receipt number must
    // NEVER stand in for the bill's identity — hence the separate helper.
    //
    // Revert-survivable: the input ALSO carries an RC receipt number (cast in —
    // `issuedInvoiceIdentity` does not declare the field). If the impl ever
    // regressed to fall back to `receiptDocumentNumberRaw` (the
    // displayDocumentNumber behaviour), this would return 'RC-2026-000015'
    // instead of null and the assertion would fail.
    expect(
      issuedInvoiceIdentity({
        documentNumber: null,
        billDocumentNumberRaw: null,
        receiptDocumentNumberRaw: 'RC-2026-000015',
      } as Parameters<typeof issuedInvoiceIdentity>[0]),
    ).toBeNull();
    // Same shape through displayDocumentNumber WOULD pick up the RC — proving
    // the two helpers are intentionally different reads.
    expect(
      displayDocumentNumber({
        documentNumber: null,
        receiptDocumentNumberRaw: 'RC-2026-000015',
      }),
    ).toBe('RC-2026-000015');
  });
});

describe('isTerminal — void + credited are terminal; others are not', () => {
  it.each([
    ['draft', false],
    ['issued', false],
    ['paid', false],
    ['partially_credited', false],
    ['void', true],
    ['credited', true],
  ] as const)('isTerminal(%s) === %s', (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});

describe("enforceOneSubjectLine('membership') — exactly-one invariant on issue", () => {
  const makeLine = (kind: InvoiceLine['kind']): InvoiceLine =>
    ({
      kind,
      // Fields irrelevant to the invariant — type-erased to keep the
      // test focused.
    }) as unknown as InvoiceLine;

  it('returns ok with exactly one membership_fee line', () => {
    const r = enforceOneSubjectLine('membership', [
      makeLine('membership_fee'),
      makeLine('discount' as InvoiceLine['kind']),
    ]);
    expect(r.ok).toBe(true);
  });

  it('returns err.no_membership_line when count === 0', () => {
    const r = enforceOneSubjectLine('membership', [
      makeLine('discount' as InvoiceLine['kind']),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no_membership_line');
    }
  });

  it('returns err.no_membership_line when lines is empty', () => {
    const r = enforceOneSubjectLine('membership', []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no_membership_line');
    }
  });

  it('returns err.multiple_membership_lines with count when > 1', () => {
    const r = enforceOneSubjectLine('membership', [
      makeLine('membership_fee'),
      makeLine('membership_fee'),
      makeLine('membership_fee'),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('multiple_membership_lines');
      if (r.error.code === 'multiple_membership_lines') {
        expect(r.error.count).toBe(3);
      }
    }
  });
});

describe("enforceOneSubjectLine('event') — exactly-one invariant on issue", () => {
  // LOW-14 — locks the event-subject 0/1/>1 behaviour so the shared-rule
  // refactor of enforceOneSubjectLine cannot silently diverge either branch.
  const makeLine = (kind: InvoiceLine['kind']): InvoiceLine =>
    ({ kind }) as unknown as InvoiceLine;

  it('returns ok with exactly one event_fee line', () => {
    const r = enforceOneSubjectLine('event', [
      makeLine('event_fee'),
      makeLine('discount' as InvoiceLine['kind']),
    ]);
    expect(r.ok).toBe(true);
  });

  it('returns err.no_event_fee_line when count === 0', () => {
    const r = enforceOneSubjectLine('event', [
      makeLine('discount' as InvoiceLine['kind']),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no_event_fee_line');
    }
  });

  it('returns err.no_event_fee_line when lines is empty', () => {
    const r = enforceOneSubjectLine('event', []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no_event_fee_line');
    }
  });

  it('returns err.multiple_event_fee_lines with count when > 1', () => {
    const r = enforceOneSubjectLine('event', [
      makeLine('event_fee'),
      makeLine('event_fee'),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('multiple_event_fee_lines');
      if (r.error.code === 'multiple_event_fee_lines') {
        expect(r.error.count).toBe(2);
      }
    }
  });
});

describe('assertSnapshotsSet — non-draft snapshot completeness', () => {
  const validDigest = Sha256Hex.ofUnsafe('a'.repeat(64));
  const makeBase = (overrides: Partial<Invoice> = {}): Invoice =>
    ({
      tenantId: 'test-swecham',
      invoiceId: asInvoiceId(VALID_UUID),
      memberId: 'mem-1',
      planId: 'plan-1',
      planYear: 2026,
      status: 'issued',
      draftByUserId: 'u-1',
      fiscalYear: 2026 as unknown as Invoice['fiscalYear'],
      sequenceNumber: 1,
      documentNumber: 'INV-2026-000001' as unknown as Invoice['documentNumber'],
      issueDate: '2026-05-17',
      dueDate: '2026-06-16',
      paidAt: null,
      voidedAt: null,
      currency: 'THB',
      subtotal: Money.fromSatangUnsafe(100_000n),
      vatRate: '0.0700' as unknown as Invoice['vatRate'],
      vat: Money.fromSatangUnsafe(7_000n),
      total: Money.fromSatangUnsafe(107_000n),
      creditedTotal: Money.fromSatangUnsafe(0n),
      proRatePolicy: 'none' as unknown as Invoice['proRatePolicy'],
      netDays: 30,
      tenantIdentitySnapshot: {} as Invoice['tenantIdentitySnapshot'],
      memberIdentitySnapshot: {} as Invoice['memberIdentitySnapshot'],
      paymentMethod: null,
      paymentReference: null,
      paymentNotes: null,
      paymentRecordedByUserId: null,
      paymentDate: null,
      voidReason: null,
      voidedByUserId: null,
      autoEmailOnIssue: null,
      pdf: {
        blobKey: 'invoices/test',
        sha256: validDigest,
        templateVersion: 1,
      },
      receiptPdf: null,
      receiptPdfStatus: null,
      receiptPdfRenderAttempts: 0,
      receiptPdfLastError: null,
      receiptDocumentNumberRaw: null,
      lines: [],
      createdAt: '2026-05-17T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
      ...overrides,
    }) as Invoice;

  it('returns ok when all snapshots set', () => {
    const r = assertSnapshotsSet(makeBase());
    expect(r.ok).toBe(true);
  });

  it('returns err.missing_snapshot.subtotal when subtotal is null', () => {
    const r = assertSnapshotsSet(makeBase({ subtotal: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('missing_snapshot');
      if (r.error.code === 'missing_snapshot') {
        expect(r.error.field).toBe('subtotal');
      }
    }
  });

  it('returns err.missing_snapshot.vatRate when vatRate is null', () => {
    const r = assertSnapshotsSet(makeBase({ vatRate: null }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing_snapshot') {
      expect(r.error.field).toBe('vatRate');
    }
  });

  it('returns err.missing_snapshot.tenantIdentitySnapshot when null', () => {
    const r = assertSnapshotsSet(makeBase({ tenantIdentitySnapshot: null }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing_snapshot') {
      expect(r.error.field).toBe('tenantIdentitySnapshot');
    }
  });

  it('returns err.missing_snapshot.memberIdentitySnapshot when null', () => {
    const r = assertSnapshotsSet(makeBase({ memberIdentitySnapshot: null }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing_snapshot') {
      expect(r.error.field).toBe('memberIdentitySnapshot');
    }
  });

  it('returns err.missing_snapshot.pdf when pdf is null', () => {
    const r = assertSnapshotsSet(makeBase({ pdf: null }));
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing_snapshot') {
      expect(r.error.field).toBe('pdf');
    }
  });

  it('reports subtotal first when multiple snapshots missing (ordering)', () => {
    // The guard short-circuits on first failure.
    const r = assertSnapshotsSet(
      makeBase({ subtotal: null, vatRate: null, pdf: null }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'missing_snapshot') {
      expect(r.error.field).toBe('subtotal');
    }
  });
});

describe('canTransition — invoice state-machine table (data-model.md § 3.1)', () => {
  const ok = (from: InvoiceStatus, to: InvoiceStatus) =>
    expect(canTransition(from, to, 'membership').ok).toBe(true);

  const err = (
    from: InvoiceStatus,
    to: InvoiceStatus,
    expectedCode: 'invalid_transition' | 'terminal_state',
  ) => {
    const r = canTransition(from, to, 'membership');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(expectedCode);
    }
  };

  describe('legal transitions', () => {
    it('draft → issued', () => ok('draft', 'issued'));
    it('issued → paid', () => ok('issued', 'paid'));
    it('issued → void', () => ok('issued', 'void'));
    it('paid → partially_credited', () => ok('paid', 'partially_credited'));
    it('paid → credited', () => ok('paid', 'credited'));
    // 088 (data-model.md § 3.1 — `paid --void--> void`): an admin may void a
    // PAID invoice (the void use-case's own guard accepts `paid`).
    it('paid → void (admin void of a paid invoice)', () => ok('paid', 'void'));
    it('partially_credited → partially_credited (sequential CN)', () =>
      ok('partially_credited', 'partially_credited'));
    it('partially_credited → credited', () =>
      ok('partially_credited', 'credited'));
  });

  describe('illegal transitions — invalid_transition', () => {
    it('issued → credited (must pay first)', () =>
      err('issued', 'credited', 'invalid_transition'));
    it('issued → partially_credited (must pay first)', () =>
      err('issued', 'partially_credited', 'invalid_transition'));
    it('paid → issued (no rollback)', () =>
      err('paid', 'issued', 'invalid_transition'));
  });

  describe('subject-aware draft → paid (064 as-paid issuance)', () => {
    it('draft→paid is legal for event subject (as-paid issuance)', () => {
      expect(canTransition('draft', 'paid', 'event').ok).toBe(true);
    });
    it('draft→paid stays ILLEGAL for membership (must pass issued)', () => {
      const r = canTransition('draft', 'paid', 'membership');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_transition');
    });
    it('draft→issued stays legal for BOTH subjects (bill-first)', () => {
      expect(canTransition('draft', 'issued', 'event').ok).toBe(true);
      expect(canTransition('draft', 'issued', 'membership').ok).toBe(true);
    });
  });

  describe('terminal-state guard', () => {
    it('void → anything = terminal_state', () => {
      err('void', 'issued', 'terminal_state');
      err('void', 'paid', 'terminal_state');
      err('void', 'credited', 'terminal_state');
    });

    it('credited → anything = terminal_state', () => {
      err('credited', 'issued', 'terminal_state');
      err('credited', 'paid', 'terminal_state');
      err('credited', 'void', 'terminal_state');
    });
  });

  it('reports the actual `from` status in terminal_state error', () => {
    const r = canTransition('void', 'paid', 'membership');
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'terminal_state') {
      expect(r.error.status).toBe('void');
    }
  });

  it('reports both from + to in invalid_transition error', () => {
    const r = canTransition('draft', 'paid', 'membership');
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'invalid_transition') {
      expect(r.error.from).toBe('draft');
      expect(r.error.to).toBe('paid');
    }
  });
});
