/**
 * `document-kind` Domain helper unit tests.
 *
 * FIX 5 (Round-2 code-review) de-duplicated the §86/4 event-document-kind
 * discriminator across issue-invoice / record-payment / issue-credit-note so
 * the issue-time, payment-time, and credit-time gates stay in lockstep — a
 * divergence would re-open the §105/§86-4 ship-blocker.
 *
 * 059 / PR-A Task 6a — the discriminator is RE-KEYED off `buyerHasTin` onto the
 * buyer's VAT-REGISTRANT status. It used to ask "is this text field non-blank",
 * which meant a foreign natural person typing a passport / work-permit number
 * into `tax_id` silently upgraded their own §105 ใบเสร็จรับเงิน into a §86/4
 * ใบกำกับภาษี — a legal document-class change triggered by a text field.
 *
 * `buyerHasTin` SURVIVES: it is still the right predicate for "do we have a
 * number to print", and it is still the registrant proxy on the WALK-IN path
 * (see `resolveBuyerIsVatRegistrant` below).
 *
 * Authored RED-first 2026-06-05; re-keyed RED-first 2026-07-14.
 */
import { describe, expect, it } from 'vitest';
import {
  buyerHasTin,
  inferEventDocumentKind,
  inferReceiptKind,
  resolveBuyerIsVatRegistrant,
  type EventDocumentKind,
  type ReceiptDocumentKind,
} from '@/modules/invoicing/domain/document-kind';

describe('buyerHasTin — §86/4 buyer-TIN presence discriminator (FIX 5)', () => {
  it('returns false for null', () => {
    expect(buyerHasTin(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(buyerHasTin(undefined)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(buyerHasTin('')).toBe(false);
  });

  it('returns false for a whitespace-only string (matches .trim())', () => {
    expect(buyerHasTin('   ')).toBe(false);
    expect(buyerHasTin('\t')).toBe(false);
    expect(buyerHasTin('\n')).toBe(false);
    expect(buyerHasTin(' \t\n ')).toBe(false);
  });

  it('returns true for a 13-digit TIN', () => {
    expect(buyerHasTin('1234567890123')).toBe(true);
  });

  it('returns true for a TIN padded with surrounding whitespace', () => {
    // Mirrors the legacy `(taxId ?? '').trim() !== ''` — a value that is
    // non-empty AFTER trimming counts as present. The non-empty content,
    // not the padding, is what matters.
    expect(buyerHasTin('  1234567890123  ')).toBe(true);
  });
});

describe('inferEventDocumentKind — ISSUE-time doc-kind (keyed on REGISTRANT status)', () => {
  it('event + NOT a registrant → receipt_separate (§105 ใบเสร็จรับเงิน)', () => {
    const kind: EventDocumentKind = inferEventDocumentKind('event', false);
    expect(kind).toBe('receipt_separate');
  });

  it('event + registrant → invoice (§86/4 ใบกำกับภาษี — buyer can claim input VAT)', () => {
    expect(inferEventDocumentKind('event', true)).toBe('invoice');
  });

  it('membership → invoice, registrant or not (never a §105 receipt)', () => {
    // The discriminator is subject-gated: ONLY `event` can resolve to
    // `receipt_separate`. 066 relax — a non-registrant membership buyer gets a
    // valid §86/4 with name+address and NO TIN line; it is never a §105 receipt.
    expect(inferEventDocumentKind('membership', true)).toBe('invoice');
    expect(inferEventDocumentKind('membership', false)).toBe('invoice');
  });
});

describe('inferReceiptKind — PAYMENT-time receipt kind (keyed on REGISTRANT status)', () => {
  it('event + NOT a registrant → receipt_separate (§105 ใบเสร็จรับเงิน)', () => {
    const kind: ReceiptDocumentKind = inferReceiptKind('event', false);
    expect(kind).toBe('receipt_separate');
  });

  it('event + registrant → receipt_combined (§86/4 + §105ทวิ)', () => {
    expect(inferReceiptKind('event', true)).toBe('receipt_combined');
  });

  it('membership → receipt_combined, registrant or not (ALWAYS a §86/4 tax receipt)', () => {
    expect(inferReceiptKind('membership', true)).toBe('receipt_combined');
    expect(inferReceiptKind('membership', false)).toBe('receipt_combined');
  });
});

describe('resolveBuyerIsVatRegistrant — the ONE place the registrant boolean is derived', () => {
  // A MATCHED MEMBER (memberId non-null) resolves to the RECORDED fact pinned on
  // the snapshot at issue (`members.is_vat_registered`, migration 0246). This is
  // the whole point of Task 6a: never re-derive it from the emptiness of tax_id,
  // because tax_id may now legitimately hold a passport / work-permit number for
  // a foreign natural person.
  const memberId = '11111111-1111-1111-1111-111111111111';

  it('matched member + recorded registrant → true', () => {
    expect(
      resolveBuyerIsVatRegistrant(memberId, {
        tax_id: '0105562000123',
        buyer_is_vat_registrant: true,
      }),
    ).toBe(true);
  });

  it('matched member + recorded NON-registrant → false EVEN WITH a non-blank tax_id', () => {
    // THE REGRESSION THIS FUNCTION EXISTS TO PREVENT. A foreign natural person
    // stores a passport number in tax_id. Under the old `buyerHasTin` key this
    // returned true and flipped their §105 receipt into a §86/4 tax invoice.
    expect(
      resolveBuyerIsVatRegistrant(memberId, {
        tax_id: 'AA1234567', // a passport, not a TIN
        buyer_is_vat_registrant: false,
      }),
    ).toBe(false);
  });

  it('matched member + snapshot written BEFORE the flag existed → false (fail-closed)', () => {
    // The zod schema declares `.optional().default(false)`, so a historical
    // snapshot that omits the key reads back false. Fail closed: no branch line,
    // no TIN line (at v>=11), and an event doc resolves to the §105 receipt.
    expect(
      resolveBuyerIsVatRegistrant(memberId, { tax_id: '0105562000123' }),
    ).toBe(false);
  });

  it('WALK-IN buyer (memberId null) → infers from TIN presence (UNCHANGED behaviour)', () => {
    // A non-member event buyer has NO `members` row, so there is no recorded
    // `is_vat_registered` to read — their snapshot's `buyer_is_vat_registrant` is
    // always the zod default `false`. Keying them on the recorded flag would
    // regress EVERY walk-in with a real company TIN from a §86/4 tax invoice to a
    // §105 receipt. TIN-presence is a safe proxy here and ONLY here, because the
    // walk-in `buyer.tax_id` is `/^\d{13}$/`-locked at the draft boundary — a
    // passport can never reach this path.
    expect(resolveBuyerIsVatRegistrant(null, { tax_id: '0105562000123' })).toBe(true);
    expect(resolveBuyerIsVatRegistrant(null, { tax_id: null })).toBe(false);
    expect(resolveBuyerIsVatRegistrant(null, { tax_id: '   ' })).toBe(false);
  });

  it('WALK-IN buyer: the snapshot flag is IGNORED (it is always the false default)', () => {
    expect(
      resolveBuyerIsVatRegistrant(null, {
        tax_id: '0105562000123',
        buyer_is_vat_registrant: false,
      }),
    ).toBe(true);
  });

  it('a missing / null buyer snapshot → false (fail-closed)', () => {
    // A corrupt event row with no buyer snapshot resolves to non-registrant →
    // receipt_separate → blocked by the §86/10 credit gate. Fail closed.
    expect(resolveBuyerIsVatRegistrant(memberId, null)).toBe(false);
    expect(resolveBuyerIsVatRegistrant(memberId, undefined)).toBe(false);
    expect(resolveBuyerIsVatRegistrant(null, null)).toBe(false);
  });
});
