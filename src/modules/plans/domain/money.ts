/**
 * `Money` — integer-minor-units value helper.
 *
 * F2 stores every money field as a **non-negative integer** in the
 * currency's smallest unit (e.g. satang for THB, öre for SEK, cents for
 * EUR/USD). Currency is resolved once per tenant via F4
 * `getTenantTaxPolicy` (reading the `tenant_invoice_settings` table —
 * R8 consolidation, post-migration 0029) so `Money` is an ephemeral
 * helper used at the Application boundary — it is NOT persisted with
 * a currency-per-row.
 *
 * Invariants enforced by `asMoney` / `asMinorUnits`:
 *   - `amount_minor_units` is a non-negative integer (no floats, no NaN)
 *   - `currency_code` is one of the 10 ISO 4217 codes on the allow-list
 *   - arithmetic (`addVat`, `add`, `subtract`, `multiply`) preserves
 *     integerness and rejects cross-currency mixing
 *
 * Formatting goes through `Intl.NumberFormat` which knows each
 * currency's decimal places — we never hard-code "2 decimals" (JPY
 * has 0, KWD has 3).
 *
 * Pure TypeScript — no framework imports.
 */

// Branded `Money` type. The brand is a phantom `unique symbol`
// property that exists only at the type level (never at runtime).
// Callers MUST construct Money
// values through `asMoney()` — direct object-literal construction
// `{ amount_minor_units, currency_code } satisfies Money` fails
// typecheck because it can't provide the brand property. This
// prevents the off-by-100x (THB vs satang) class of bug at the
// boundary instead of at runtime via `asMinorUnits` invariants.
//
// Template borrowed from `src/modules/tenants/domain/iana-timezone.ts`
// — the A-grade reference for branded value types in this codebase.
declare const MoneyBrand: unique symbol;

export type Money = {
  readonly amount_minor_units: number;
  readonly currency_code: CurrencyCode;
} & { readonly [MoneyBrand]: true };

/** ISO 4217 currency codes recognised by Chamber-OS F2. */
export const SUPPORTED_CURRENCIES = [
  'THB',
  'SEK',
  'EUR',
  'USD',
  'JPY',
  'SGD',
  'GBP',
  'DKK',
  'NOK',
  'CHF',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return (
    typeof value === 'string' &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Validate + brand a raw integer as minor-units. Throws on:
 *   - non-number (string, null, undefined)
 *   - non-integer (1.5)
 *   - negative
 *   - NaN / Infinity
 *   - >10 billion (sanity ceiling — 10 * 10^9 fits in JS safe integer
 *     range and is larger than any plausible annual fee)
 */
export function asMinorUnits(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidMoneyError(`Expected finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new InvalidMoneyError(
      `Expected integer minor_units, got non-integer ${value}. Use the minor currency unit (satang / öre / cents).`,
    );
  }
  if (value < 0) {
    throw new InvalidMoneyError(`Expected non-negative minor_units, got ${value}`);
  }
  if (value > 10_000_000_000) {
    throw new InvalidMoneyError(
      `Minor units ${value} exceeds sanity ceiling of 10_000_000_000`,
    );
  }
  return value;
}

/**
 * Wraps `Plan.annual_fee_minor_units` (unbranded `number` field —
 * Round-1 trade-off) with a `Money` brand + the tenant's currency
 * from `tenant_invoice_settings`. Recommended path for NEW Domain
 * code that needs the cross-currency-safe brand (e.g., totalling
 * fees across plans without risking SEK+THB-without-conversion).
 *
 * The signature requires `CurrencyCode` (the branded type), not
 * `string`. Callers that already hold the brand
 * (e.g., `getTenantTaxPolicy().currencyCode`) get a type-safe path;
 * callers with a raw `string` should call `asMoney(...)` directly
 * (which still re-validates via `isCurrencyCode`).
 *
 * @param annualFeeMinorUnits — the raw integer from `Plan.annual_fee_minor_units`
 * @param currencyCode — resolved per-tenant via F4 `getTenantTaxPolicy`
 * @returns branded `Money` value safe for arithmetic
 * @throws InvalidMoneyError on negative / non-integer / >10B overflow
 */
export function planAnnualFee(
  annualFeeMinorUnits: number,
  currencyCode: CurrencyCode,
): Money {
  return asMoney(annualFeeMinorUnits, currencyCode);
}

/** Construct a validated `Money` record (the only blessed path —
 *  see brand note on the `Money` type). */
export function asMoney(amountMinorUnits: number, currencyCode: string): Money {
  if (!isCurrencyCode(currencyCode)) {
    throw new InvalidMoneyError(
      `Unknown currency code ${JSON.stringify(currencyCode)}. Allowed: ${SUPPORTED_CURRENCIES.join(', ')}`,
    );
  }
  // Validated — brand cast at the smart-constructor boundary. The
  // `MoneyBrand` symbol never exists at runtime, so this cast does
  // not affect the actual object shape.
  return {
    amount_minor_units: asMinorUnits(amountMinorUnits),
    currency_code: currencyCode,
  } as Money;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency_code !== b.currency_code) {
    throw new InvalidMoneyError(
      `Cross-currency operation rejected: ${a.currency_code} vs ${b.currency_code}. Convert first.`,
    );
  }
}

/** Add two Money values of the same currency. Integer-only. */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return asMoney(a.amount_minor_units + b.amount_minor_units, a.currency_code);
}

/** Subtract `b` from `a`. Rejects negative result (non-negative invariant). */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return asMoney(a.amount_minor_units - b.amount_minor_units, a.currency_code);
}

/**
 * Multiply `a` by an integer factor. Rejects non-integer factor or
 * negative result to preserve the non-negative invariant.
 */
export function multiplyMoney(a: Money, factor: number): Money {
  if (!Number.isInteger(factor) || factor < 0) {
    throw new InvalidMoneyError(
      `Multiply factor must be a non-negative integer, got ${factor}`,
    );
  }
  return asMoney(a.amount_minor_units * factor, a.currency_code);
}

/**
 * Apply a VAT rate and return the new Money (rounded to the nearest
 * minor-unit integer). VAT rate is a decimal fraction (0.07 = 7%).
 *
 * Uses `Math.round` — the rounding error cap is ±0.5 minor-units which
 * is sub-cent and below accounting-level precision. If F4/F5 invoicing
 * needs a different rounding policy (banker's, floor, half-up), add
 * an explicit variant function; do NOT silently change the default.
 *
 * Example:
 *   addVat({ amount_minor_units: 3_600_000, currency_code: 'THB' }, 0.07)
 *   // → { amount_minor_units: 3_852_000, currency_code: 'THB' }   (7% on 36,000 THB)
 */
export function addVat(a: Money, vatRate: number): Money {
  if (typeof vatRate !== 'number' || !Number.isFinite(vatRate)) {
    throw new InvalidMoneyError(`VAT rate must be a finite number, got ${String(vatRate)}`);
  }
  if (vatRate < 0 || vatRate >= 1) {
    throw new InvalidMoneyError(`VAT rate ${vatRate} out of range [0, 1)`);
  }
  const withVat = Math.round(a.amount_minor_units * (1 + vatRate));
  return asMoney(withVat, a.currency_code);
}

/**
 * Format a Money value for display using `Intl.NumberFormat` in the
 * requested BCP-47 locale. The formatter knows each currency's decimal
 * places — we never hard-code "divide by 100".
 *
 * Example:
 *   formatMoney({ amount_minor_units: 3_600_000, currency_code: 'THB' }, 'th-TH')
 *   // → '฿36,000.00'
 */
export function formatMoney(money: Money, locale: string): string {
  // Intl.NumberFormat takes MAJOR units — divide by the currency's
  // minor-unit factor. We can't look that up without `resolvedOptions`,
  // so we format via `formatToParts` on an Intl.NumberFormat with the
  // currency set, then back-fill.
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency_code,
  });
  // `resolvedOptions().maximumFractionDigits` is the currency's native
  // fraction-digit count (0 for JPY, 2 for THB/SEK/EUR/USD, 3 for KWD).
  const digits = fmt.resolvedOptions().maximumFractionDigits!
  const major = money.amount_minor_units / Math.pow(10, digits);
  return fmt.format(major);
}
