/**
 * T024 — VatRate value object (F4).
 *
 * Percentage as 4-dp decimal, bounded [0, 0.30] (0% to 30%).
 * Thai RD standard rate = 0.0700 (7%). Zero-rating allowed for exempt
 * members (e.g. NGOs) — hence lower bound inclusive of zero.
 */

export type VatRateError =
  | { kind: 'out_of_range'; value: string }
  | { kind: 'malformed'; value: string };

const RE_4DP = /^(?:0|[1-9]\d*)\.\d{4}$/;

export class VatRate {
  /** DB-compatible string form, always `x.xxxx`. */
  readonly raw: string;

  private constructor(raw: string) {
    this.raw = raw;
  }

  static of(raw: string): { ok: true; value: VatRate } | { ok: false; error: VatRateError } {
    if (!RE_4DP.test(raw)) return { ok: false, error: { kind: 'malformed', value: raw } };
    // Parse to float only for range check — precision is preserved in `raw`.
    const f = Number(raw);
    if (f < 0 || f > 0.3) return { ok: false, error: { kind: 'out_of_range', value: raw } };
    return { ok: true, value: new VatRate(raw) };
  }

  static ofUnsafe(raw: string): VatRate {
    const r = VatRate.of(raw);
    if (!r.ok) throw new Error(`VatRate.ofUnsafe: invalid ${raw} (${r.error.kind})`);
    return r.value;
  }

  /** Machine-readable fraction numerator (satang-compatible). */
  get numerator(): bigint {
    // "0.0700" → 700 (out of 10000)
    return BigInt(this.raw.replace('.', ''));
  }
  get denominator(): bigint {
    return 10_000n;
  }

  equals(other: VatRate): boolean {
    return this.raw === other.raw;
  }

  toPercentString(): string {
    // "0.0700" → "7.00%"
    const pct = Number(this.raw) * 100;
    return `${pct.toFixed(2)}%`;
  }
}
