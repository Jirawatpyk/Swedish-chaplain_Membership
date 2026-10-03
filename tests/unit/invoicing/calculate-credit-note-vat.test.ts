/**
 * T076 — Proportional VAT policy for credit notes.
 *
 * Property (residual rule, replaces post-critique E7's "≤ +1 satang"):
 *   forAll (total ≥ 100)(partition into 1..8 parts)(vatRate ∈ [0, 0.30]) →
 *     every running sum(cn-vats) ≤ original-vat, and the note that completes
 *     the credit brings sum(cn-vats) to EXACTLY original-vat.
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
    expect(r.vat.satang).toBeLessThanOrEqual(part);
    expect(r.creditAmount.satang + r.vat.satang).toBe(part);
    vats.push(r.vat.satang);
    alreadyCredited = alreadyCredited.add(Money.fromSatangUnsafe(part));
    priorCreditedVat = priorCreditedVat.add(r.vat);
  }
  return vats;
}

describe('calculateCreditNoteVat — residual on the completing note', () => {
  it('three partials of a 1,070.00 THB invoice credit exactly 70.00 VAT (2,181 + 2,181 + 2,638)', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    // Pre-fix: 2,181 + 2,181 + 2,639 = 7,001 — one satang more than charged.
    expect(creditInParts(v.vat, v.total, [33_333n, 33_333n, 40_334n])).toEqual([2_181n, 2_181n, 2_638n]);
  });

  it('five partials also land exactly (pre-fix: 7,002)', () => {
    const v = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    const vats = creditInParts(v.vat, v.total, [10_081n, 10_081n, 10_081n, 10_081n, 66_676n]);
    expect(vats.reduce((a, b) => a + b, 0n)).toBe(v.vat.satang);
  });

  it('a partial is still proportional — only the completing note takes the residual', () => {
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
    expect(r.vat.satang).toBe(2_181n);
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
        (subtotalSatang, vatBp, weights) => {
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
          parts.push(originalTotal.satang - allocated);

          const vats = creditInParts(originalVat, originalTotal, parts);
          let running = 0n;
          for (const v of vats) {
            running += v;
            expect(running).toBeLessThanOrEqual(originalVat.satang);
          }
          expect(running).toBe(originalVat.satang);
        },
      ),
      { numRuns: 500 },
    );
  });
});
