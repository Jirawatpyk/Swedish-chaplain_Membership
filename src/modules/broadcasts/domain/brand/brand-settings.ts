/**
 * F119 T018 — Chamber brand settings value objects (FR-041b / FR-041c).
 *
 * Exactly one primary colour (`#RRGGBB`, contrast-checked by the use case
 * through `contrast.ts`) and the chamber's postal address (≤ 300 characters,
 * line breaks allowed). The logo URL is READ-only — it belongs to
 * `tenant_invoice_settings` and is never parsed or written here.
 *
 * Brand chrome is applied live at render time and is never frozen into a
 * version, so a brand change never voids an approval (FR-012).
 */
import { err, ok, type Result } from '@/lib/result';

/** Platform default when no tenant colour is set (`src/lib/email-brand.ts`). */
export const DEFAULT_BRAND_PRIMARY_COLOR = '#10487a' as const;
export const BRAND_POSTAL_ADDRESS_MAX = 300 as const;

export interface BrandSettings {
  /** `#rrggbb` (lower case) or null ⇒ the platform default applies. */
  readonly primaryColor: string | null;
  /** Free text ≤ 300 chars, LF line breaks; null ⇒ footer shows the chamber name only. */
  readonly postalAddress: string | null;
  /** Public URL of the invoice logo on file; READ-only, null ⇒ chamber name in the header. */
  readonly logoUrl: string | null;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export type BrandColorError = { readonly code: 'invalid_color_format' };

/** `#RRGGBB` → normalised lower case; `null` clears the colour. */
export function parseBrandPrimaryColor(
  input: string | null,
): Result<string | null, BrandColorError> {
  if (input === null) return ok(null);
  if (!HEX6.test(input)) return err({ code: 'invalid_color_format' });
  return ok(input.toLowerCase());
}

export type BrandPostalAddressError = {
  readonly code: 'address_too_long';
  readonly max: typeof BRAND_POSTAL_ADDRESS_MAX;
};

/**
 * Trims, normalises CRLF → LF (so the stored length is what the user sees
 * in the textarea), bounds to 300 characters; whitespace-only ⇒ null.
 */
export function parseBrandPostalAddress(
  input: string | null,
): Result<string | null, BrandPostalAddressError> {
  if (input === null) return ok(null);
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) return ok(null);
  if (text.length > BRAND_POSTAL_ADDRESS_MAX) {
    return err({ code: 'address_too_long', max: BRAND_POSTAL_ADDRESS_MAX });
  }
  return ok(text);
}
