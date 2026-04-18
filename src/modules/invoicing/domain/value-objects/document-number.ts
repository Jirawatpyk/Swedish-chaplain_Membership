/**
 * T025 — DocumentNumber value object (F4).
 *
 * Canonical format: `{prefix}-{YYYY}-{NNNNNN}` — 6-digit zero-padded
 * sequential number. `YYYY` is the calendar year corresponding to the
 * fiscal year (CE, not BE; BE is only rendered in Thai PDF body).
 *
 * Overflow (FR-035): rejects sequence numbers > 999_999. The 6-digit
 * convention matches Thai accounting practice; SweCham's historical
 * Excel workbook tops out at a few hundred invoices / yr, so the ceiling
 * is far beyond realistic load but still bounded.
 */

export type DocumentNumberError =
  | { kind: 'overflow'; sequenceNumber: number }
  | { kind: 'invalid_prefix'; prefix: string }
  | { kind: 'invalid_sequence'; sequenceNumber: number }
  | { kind: 'malformed'; raw: string };

const RE_PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;
const MAX_SEQ = 999_999;

export class DocumentNumber {
  readonly raw: string;
  readonly prefix: string;
  readonly fiscalYear: number;
  readonly sequenceNumber: number;

  private constructor(
    raw: string,
    prefix: string,
    fiscalYear: number,
    sequenceNumber: number,
  ) {
    this.raw = raw;
    this.prefix = prefix;
    this.fiscalYear = fiscalYear;
    this.sequenceNumber = sequenceNumber;
  }

  /** Build from parts. Rejects out-of-range / malformed inputs. */
  static of(
    prefix: string,
    fiscalYear: number,
    sequenceNumber: number,
  ):
    | { ok: true; value: DocumentNumber }
    | { ok: false; error: DocumentNumberError } {
    if (!RE_PREFIX.test(prefix)) return { ok: false, error: { kind: 'invalid_prefix', prefix } };
    if (!Number.isInteger(sequenceNumber) || sequenceNumber <= 0) {
      return { ok: false, error: { kind: 'invalid_sequence', sequenceNumber } };
    }
    if (sequenceNumber > MAX_SEQ) {
      return { ok: false, error: { kind: 'overflow', sequenceNumber } };
    }
    const padded = sequenceNumber.toString().padStart(6, '0');
    const raw = `${prefix}-${fiscalYear}-${padded}`;
    return { ok: true, value: new DocumentNumber(raw, prefix, fiscalYear, sequenceNumber) };
  }

  /** Parse raw string back to parts — used for audit trail reconstruction. */
  static parse(raw: string):
    | { ok: true; value: DocumentNumber }
    | { ok: false; error: DocumentNumberError } {
    const m = raw.match(/^([A-Z][A-Z0-9]{0,7})-(\d{4})-(\d{6})$/);
    if (!m) return { ok: false, error: { kind: 'malformed', raw } };
    const [, prefix, yearStr, seqStr] = m;
    const year = Number(yearStr);
    const seq = Number(seqStr);
    return DocumentNumber.of(prefix!, year, seq);
  }

  equals(other: DocumentNumber): boolean {
    return this.raw === other.raw;
  }
}

export { MAX_SEQ as DOCUMENT_NUMBER_MAX_SEQ };
