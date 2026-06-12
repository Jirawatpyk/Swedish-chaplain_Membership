/**
 * FIX 5 (Round-2 code-review) — `document-kind` Domain helper unit tests.
 *
 * The §86/4 buyer-TIN / event-document-kind discriminator was duplicated
 * VERBATIM across three security-critical use-cases (issue-invoice,
 * record-payment, issue-credit-note). This pure Domain helper de-duplicates
 * it so the issue-time, payment-time, and credit-time gates stay in
 * lockstep — a divergence would re-open the §105/§86-4 ship-blocker.
 *
 * Behaviour MUST be byte-identical to the three former inline expressions:
 *   buyerHasTin(taxId)           === (taxId ?? '').trim() !== ''
 *   inferEventDocumentKind(s, t)  === (s === 'event' && !buyerHasTin(t))
 *                                       ? 'receipt_separate' : 'invoice'
 *
 * Authored RED-first 2026-06-05.
 */
import { describe, expect, it } from 'vitest';
import {
  buyerHasTin,
  inferEventDocumentKind,
  type EventDocumentKind,
} from '@/modules/invoicing/domain/document-kind';

describe('buyerHasTin — §86/4 buyer-TIN discriminator (FIX 5)', () => {
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

describe('inferEventDocumentKind — event PDF doc-kind discriminator (FIX 5)', () => {
  it('event + no TIN → receipt_separate (§105 ใบเสร็จรับเงิน)', () => {
    const kind: EventDocumentKind = inferEventDocumentKind('event', null);
    expect(kind).toBe('receipt_separate');
    expect(inferEventDocumentKind('event', '')).toBe('receipt_separate');
    expect(inferEventDocumentKind('event', '   ')).toBe('receipt_separate');
    expect(inferEventDocumentKind('event', undefined)).toBe('receipt_separate');
  });

  it('event + TIN → invoice (§86/4 ใบกำกับภาษี — buyer can claim input VAT)', () => {
    expect(inferEventDocumentKind('event', '1234567890123')).toBe('invoice');
    expect(inferEventDocumentKind('event', '  1234567890123  ')).toBe('invoice');
  });

  it('membership + TIN → invoice', () => {
    expect(inferEventDocumentKind('membership', '1234567890123')).toBe('invoice');
  });

  it('membership + no TIN → invoice (a non-registrant buyer gets a valid §86/4 name+address; never a §105 receipt)', () => {
    // The discriminator is subject-gated: ONLY `event` can resolve to
    // `receipt_separate`. 066 relax — a TIN-less membership invoice ISSUES (as a
    // §86/4 with name+address, TIN line absent), and the discriminator correctly
    // keeps it labelled 'invoice' (a membership doc is never a §105 receipt).
    expect(inferEventDocumentKind('membership', null)).toBe('invoice');
    expect(inferEventDocumentKind('membership', '')).toBe('invoice');
    expect(inferEventDocumentKind('membership', '   ')).toBe('invoice');
    expect(inferEventDocumentKind('membership', undefined)).toBe('invoice');
  });
});
