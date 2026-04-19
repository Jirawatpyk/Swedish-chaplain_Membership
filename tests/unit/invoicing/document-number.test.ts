import { describe, expect, it } from 'vitest';
import {
  DocumentNumber,
  DOCUMENT_NUMBER_MAX_SEQ,
} from '@/modules/invoicing/domain/value-objects/document-number';

describe('DocumentNumber', () => {
  it('formats as SC-2026-000001', () => {
    const r = DocumentNumber.of('SC', 2026, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.raw).toBe('SC-2026-000001');
  });

  it('zero-pads to 6 digits', () => {
    const r = DocumentNumber.of('SC', 2026, 42);
    if (r.ok) expect(r.value.raw).toBe('SC-2026-000042');
  });

  it('accepts 6-digit max seq', () => {
    const r = DocumentNumber.of('SC', 2026, DOCUMENT_NUMBER_MAX_SEQ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.raw).toBe('SC-2026-999999');
  });

  it('FR-035 overflow — seq > 999999 rejected', () => {
    const r = DocumentNumber.of('SC', 2026, 1_000_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('overflow');
  });

  it('rejects non-positive sequence', () => {
    expect(DocumentNumber.of('SC', 2026, 0).ok).toBe(false);
    expect(DocumentNumber.of('SC', 2026, -1).ok).toBe(false);
  });

  it('rejects non-integer sequence', () => {
    expect(DocumentNumber.of('SC', 2026, 1.5).ok).toBe(false);
  });

  it('rejects lowercase or too-long prefix', () => {
    expect(DocumentNumber.of('sc', 2026, 1).ok).toBe(false);
    expect(DocumentNumber.of('VERYLONGPREFIX', 2026, 1).ok).toBe(false);
  });

  it('accepts alphanumeric prefix up to 8 chars', () => {
    expect(DocumentNumber.of('SC', 2026, 1).ok).toBe(true);
    expect(DocumentNumber.of('SC12', 2026, 1).ok).toBe(true);
    expect(DocumentNumber.of('ABCDEFGH', 2026, 1).ok).toBe(true);
  });

  it('parse round-trip', () => {
    const a = DocumentNumber.of('SC', 2026, 42);
    if (!a.ok) throw new Error('unreachable');
    const b = DocumentNumber.parse(a.value.raw);
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.value.prefix).toBe('SC');
      expect(b.value.fiscalYear).toBe(2026);
      expect(b.value.sequenceNumber).toBe(42);
    }
  });

  it('parse rejects malformed', () => {
    expect(DocumentNumber.parse('sc-2026-1').ok).toBe(false);
    expect(DocumentNumber.parse('SC-26-000042').ok).toBe(false);
    expect(DocumentNumber.parse('random text').ok).toBe(false);
  });
});
