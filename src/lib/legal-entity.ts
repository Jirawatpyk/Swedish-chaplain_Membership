/**
 * 088 US3 (FR-008 / AS3) — the SINGLE canonical discriminator for "is this
 * member a VAT-registrant juristic buyer?", used to gate the §86/4
 * Head-Office / Branch line on the ใบแจ้งหนี้ + tax receipt.
 *
 * `members.legal_entity_type` is UNCONSTRAINED free text (no enum / DB CHECK),
 * so the two boundaries that read it — the tax-render path
 * (`member-identity-adapter` → `buyer_is_vat_registrant`) and the admin-form
 * cross-field guard (branch-on-non-registrant) — MUST normalise identically.
 * A US3-review finding (2026-07-02) showed an exact, case-sensitive
 * `!== 'individual'` in the adapter fail-OPENs on a natural person entered as
 * `'Individual'` (capital I) or `'  individual  '` (whitespace via the API),
 * printing a Head-Office line on an individual's §86/4 receipt — a tax-document
 * defect that contradicts AS3.
 *
 * Fail-closed: `null` / `''` / any casing or surrounding whitespace of
 * `'individual'` ⇒ `false` ⇒ NO branch line. A juristic type
 * (`'company'`, `'both'`, …) ⇒ `true`.
 *
 * Pure + framework-free so BOTH `src/modules/**` (infrastructure) and
 * `src/components/**` (presentation) can share it via `@/lib` without crossing
 * a Clean-Architecture boundary.
 */
export function isVatRegistrantEntityType(
  legalEntityType: string | null | undefined,
): boolean {
  const t = legalEntityType?.trim().toLowerCase() ?? '';
  return t !== '' && t !== 'individual';
}
