/**
 * T076 — Proportional VAT policy for credit notes.
 *
 * Property (cumulative rule, replaces post-critique E7's "≤ +1 satang"):
 *   forAll (total ≥ 100)(partition into 1..8 parts, tiny parts included)
 *   (vatRate ∈ [0, 0.30]) → every note has net ≥ 1 satang (the DB CHECK),
 *   every running sum(cn-vats) ≤ original-vat, and a fully credited invoice
 *   credits EXACTLY original-vat unless a note had to keep 1 satang of net.
 *
 * The old per-note proportional rounding drifted by up to ~N/2 satang over N
 * partials (3 partials of a 1,070.00 THB invoice credited 70.01 THB VAT), so
 * the output VAT reduced could exceed the VAT charged.
 *
 * Plus deterministic happy-path + boundary cases so a regression in
 * rounding fails loudly without relying on shrinkage alone.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateCreditNoteVat } from '@/modules/invoicing/domain/policies/calculate-credit-note-vat';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

/** A credit note against an invoice nothing has been credited on yet. */
const FRESH = { alreadyCredited: Money.zero(), priorCreditedVat: Money.zero() } as const;

function expectOk<T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!r.ok) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('calculateCreditNoteVat — happy path', () => {
  it('full credit (creditTotal == originalTotal) reproduces invoice VAT exactly', () => {
    // 1000 THB @ 7% → subtotal 1000, vat 70, total 1070.
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: v.total,
        originalVat: v.vat,
        originalTotal: v.total,
        ...FRESH,
      }),
    );
    expect(r.vat.equals(v.vat)).toBe(true);
    expect(r.creditAmount.equals(v.subtotal)).toBe(true);
    expect(r.total.equals(v.total)).toBe(true);
  });

  it('half credit (≈50% of gross) splits VAT half-away-from-zero', () => {
    // originalTotal 1070 satang × 100 = 107000, originalVat 7000 satang.
    // creditTotal 53500 → vat = 7000 × 53500 / 107000 = 3500 exactly.
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const half = Money.fromTHB(535);
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: half,
        originalVat: v.vat,
        originalTotal: v.total,
        ...FRESH,
      }),
    );
    expect(r.vat.satang).toBe(3500n); // 35.00 THB
    expect(r.creditAmount.satang).toBe(50000n); // 500.00 THB
    expect(r.total.satang).toBe(53500n);
  });

  it('AS2 case — 53,500 invoice, 10,700 partial credit', () => {
    // Invoice 50000 THB @ 7% → subtotal 50000, vat 3500, total 53500.
    const v = calculateVat(Money.fromTHB(50000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromTHB(10700),
        originalVat: v.vat,
        originalTotal: v.total,
        ...FRESH,
      }),
    );
    // vat = 350000 × 1070000 / 5350000 = 70000 satang = 700.00 THB
    expect(r.vat.satang).toBe(70000n);
    expect(r.creditAmount.satang).toBe(1000000n); // 10000.00
    expect(r.total.satang).toBe(1070000n);
  });
});

describe('calculateCreditNoteVat — rejection', () => {
  it('rejects zero original total (defensive — draft invoices never reach here)', () => {
    const r = calculateCreditNoteVat({
      creditTotal: Money.fromTHB(100),
      originalVat: Money.zero(),
      originalTotal: Money.zero(),
      ...FRESH,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('zero_original_total');
  });

  it('rejects creditTotal > originalTotal', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = calculateCreditNoteVat({
      creditTotal: Money.fromTHB(2000),
      originalVat: v.vat,
      originalTotal: v.total,
      ...FRESH,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('credit_exceeds_original');
  });
});

/**
 * Issue `parts` as successive credit notes, threading what earlier notes
 * credited — what `issueCreditNote` does against the locked invoice.
 */
function creditInParts(originalVat: Money, originalTotal: Money, parts: readonly bigint[]): bigint[] {
  let alreadyCredited = Money.zero();
  let priorCreditedVat = Money.zero();
  const vats: bigint[] = [];
  for (const part of parts) {
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromSatangUnsafe(part),
        originalVat,
        originalTotal,
        alreadyCredited,
        priorCreditedVat,
      }),
    );
    expect(r.vat.satang).toBeGreaterThanOrEqual(0n);
    // credit_notes.credit_amount_satang > 0 (migration 0019): never a 0 net.
    expect(r.creditAmount.satang).toBeGreaterThanOrEqual(1n);
    expect(r.creditAmount.satang + r.vat.satang).toBe(part);
    vats.push(r.vat.satang);
    alreadyCredited = alreadyCredited.add(Money.fromSatangUnsafe(part));
    priorCreditedVat = priorCreditedVat.add(r.vat);
  }
  return vats;
}

describe('calculateCreditNoteVat — cumulative VAT (each note = target to date − VAT already credited)', () => {
  it('three partials of a 1,070.00 THB invoice credit exactly 70.00 VAT (2,181 + 2,180 + 2,639)', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    // Pre-fix: 2,181 + 2,181 + 2,639 = 7,001 — one satang more than charged.
    // Cumulative targets: round(7,000 × 33,333/107,000) = 2,181, round(… × 66,666/…) = 4,361, 7,000.
    expect(creditInParts(v.vat, v.total, [33_333n, 33_333n, 40_334n])).toEqual([2_181n, 2_180n, 2_639n]);
  });

  it('every note stays within 1 satang of its own proportional VAT, however many notes', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const parts = [10_081n, 10_081n, 10_081n, 10_081n, 10_081n, 10_081n, 10_081n, 36_433n];
    const vats = creditInParts(v.vat, v.total, parts);
    parts.forEach((part, i) => {
      const proportional = (v.vat.satang * part * 2n + v.total.satang) / (v.total.satang * 2n);
      const gap = vats[i]! - proportional;
      expect(gap <= 1n && gap >= -1n).toBe(true);
    });
  });

  it('a tiny completing note keeps net ≥ 1 satang (credit_amount_satang > 0), never a 0-net note', () => {
    // 10,700.00 incl. 700.00 VAT, credited 21.47 + 10,678.52, then 0.01.
    const v = calculateVat(Money.fromTHB(10_000), VatRate.ofUnsafe('0.0700'));
    const vats = creditInParts(v.vat, v.total, [2_147n, 1_067_852n, 1n]);
    expect(vats[2]).toBe(0n);
    expect(vats.reduce((a, b) => a + b, 0n)).toBe(v.vat.satang);
  });

  it('a 1-satang note whose VAT would round to 1 credits 0 VAT and leaves the satang for later', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromSatangUnsafe(1n),
        originalVat: v.vat,
        originalTotal: v.total,
        // round(7,000 × 7/107,000) = 0; round(7,000 × 8/107,000) = 1.
        alreadyCredited: Money.fromSatangUnsafe(7n),
        priorCreditedVat: Money.zero(),
      }),
    );
    expect(r.vat.satang).toBe(0n);
    expect(r.creditAmount.satang).toBe(1n);
  });

  it('five partials also land exactly (pre-fix: 7,002)', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const vats = creditInParts(v.vat, v.total, [10_081n, 10_081n, 10_081n, 10_081n, 66_676n]);
    expect(vats.reduce((a, b) => a + b, 0n)).toBe(v.vat.satang);
  });

  it('a partial takes its cumulative share — 2,180 here, not the 2,181 it would round to alone', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromSatangUnsafe(33_333n),
        originalVat: v.vat,
        originalTotal: v.total,
        alreadyCredited: Money.fromSatangUnsafe(33_333n),
        priorCreditedVat: Money.fromSatangUnsafe(2_181n),
      }),
    );
    expect(r.vat.satang).toBe(2_180n);
  });

  it('a partial never takes the running VAT past what was charged', () => {
    // Earlier notes (issued before this rule) already credited all 70.00 VAT.
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromSatangUnsafe(10_000n),
        originalVat: v.vat,
        originalTotal: v.total,
        alreadyCredited: Money.fromSatangUnsafe(90_000n),
        priorCreditedVat: Money.fromSatangUnsafe(7_000n),
      }),
    );
    expect(r.vat.satang).toBe(0n);
    expect(r.creditAmount.satang).toBe(10_000n);
  });

  it('a completing note after earlier over-credited VAT (legacy rows) credits no VAT, never negative', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = expectOk(
      calculateCreditNoteVat({
        creditTotal: Money.fromSatangUnsafe(40_334n),
        originalVat: v.vat,
        originalTotal: v.total,
        alreadyCredited: Money.fromSatangUnsafe(66_666n),
        priorCreditedVat: Money.fromSatangUnsafe(7_001n),
      }),
    );
    expect(r.vat.satang).toBe(0n);
    expect(r.creditAmount.satang).toBe(40_334n);
  });

  it('rejects a credit beyond what is left to credit', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const r = calculateCreditNoteVat({
      creditTotal: Money.fromSatangUnsafe(50_000n),
      originalVat: v.vat,
      originalTotal: v.total,
      alreadyCredited: Money.fromSatangUnsafe(60_000n),
      priorCreditedVat: Money.fromSatangUnsafe(3_925n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('credit_exceeds_original');
  });
});

describe('calculateCreditNoteVat — property: partitions credit exactly the VAT charged', () => {
  it('forAll (total ≥ 100 THB) (1..8 parts) (vatRate ∈ [0, 0.30]) → running sum ≤ VAT charged, final sum == VAT charged', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10_000n, max: 1_000_000_000n }),
        fc.integer({ min: 0, max: 3000 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 }),
        // Optional tiny notes (1..5 satang) carved off the end — the case that
        // once produced a 0-net note.
        fc.array(fc.bigInt({ min: 1n, max: 5n }), { maxLength: 3 }),
        (subtotalSatang, vatBp, weights, tiny) => {
          const rate = VatRate.ofUnsafe(`0.${vatBp.toString().padStart(4, '0')}`);
          const { vat: originalVat, total: originalTotal } = calculateVat(Money.fromSatangUnsafe(subtotalSatang), rate);
          const weightSum = weights.reduce((a, b) => a + b, 0);
          const parts: bigint[] = [];
          let allocated = 0n;
          for (let i = 0; i < weights.length - 1; i += 1) {
            const share = (originalTotal.satang * BigInt(weights[i] as number)) / BigInt(weightSum);
            if (share > 0n) {
              parts.push(share);
              allocated += share;
            }
          }
          const tinyTotal = tiny.reduce((a, b) => a + b, 0n);
          const last = originalTotal.satang - allocated - tinyTotal;
          if (last > 0n) parts.push(last, ...tiny);
          else parts.push(originalTotal.satang - allocated);

          const vats = creditInParts(originalVat, originalTotal, parts);
          let running = 0n;
          for (const v of vats) {
            running += v;
            expect(running).toBeLessThanOrEqual(originalVat.satang);
          }
          // Exact, unless some note had to keep its 1-satang net (VAT = gross − 1).
          const keptNet = vats.some((v, i) => parts[i]! > 0n && v === parts[i]! - 1n);
          if (!keptNet) expect(running).toBe(originalVat.satang);
        },
      ),
      { numRuns: 500 },
    );
  });
});
