/**
 * The closed vocabulary for `members.legal_entity_type`.
 *
 * **These codes are NOT free to rename.** They are the i18n keys that already
 * ship at `admin.members.detail.legalEntityTypes` (`en.json:1117-1129`), and the
 * resolver (`[memberId]/page.tsx:184-195`) falls back to the RAW stored string
 * on a miss — silently. Invent `sole_proprietorship` where the shipped key says
 * `sole_proprietor` and the member page prints the snake_case code, with no
 * error and no failing test.
 *
 * `state_enterprise` is the ONE new key. TSCC has 7 such members.
 */
export const LEGAL_ENTITY_TYPES = [
  'company',
  'limited_company',
  'public_company',
  'partnership',
  'sole_proprietor',
  'individual',
  'foundation',
  'association',
  'government',
  'branch',
  'representative_office',
  'state_enterprise',
] as const;

export type LegalEntityTypeCode = (typeof LEGAL_ENTITY_TYPES)[number];

export function isLegalEntityTypeCode(v: unknown): v is LegalEntityTypeCode {
  return (
    typeof v === 'string' &&
    (LEGAL_ENTITY_TYPES as readonly string[]).includes(v)
  );
}

/**
 * The VAT-registrant DEFAULT for a newly-picked entity type. It seeds the
 * checkbox; it is never a rule, and it is never consulted after the fact —
 * `members.is_vat_registered` is the only source of truth.
 *
 * `null` = there is NO safe default; the admin must decide.
 *
 * Verified against rd.go.th primary text (spec § 16.6):
 *   - VAT registration is a function of TURNOVER (>1.8M THB/yr — พ.ร.ฎ. ฉบับที่
 *     432 under §81/1), not of legal form. §77/1 defines ผู้ประกอบการ to include
 *     natural persons, so a sole proprietor above the threshold MUST register.
 *   - §81(1) contains no exemption by STATUS. Only §81(1)(ธ) exempts certain
 *     religious/charitable ACTIVITIES. **TSCC is itself a chamber of commerce —
 *     an association — and IS VAT-registered.** So "non-profit ⇒ not registered"
 *     is false, and a `false` default here would under-print the §86/4 line on
 *     exactly the members most like the chamber itself.
 *   - `cooperative` is deliberately ABSENT from the catalogue: TSCC has none, and
 *     research found no safe default (savings co-ops' interest falls under §91
 *     specific business tax; agricultural co-ops are exempt under §81(1)(ก) for
 *     UNPROCESSED produce only; a co-op selling VATable goods above the threshold
 *     must register). Add it only when a real member needs it — with a `null`.
 */
export const VAT_DEFAULT_BY_CODE: Readonly<
  Record<LegalEntityTypeCode, boolean | null>
> = {
  // Juristic trading forms — a registrant unless below the 1.8M threshold.
  company: true,
  limited_company: true,
  public_company: true,
  partnership: true,
  branch: true, // Thai branch of a foreign company: earns revenue, holds its own ภ.พ.20
  state_enterprise: true, // a separate juristic person; NOT covered by the §81(1)(ท) exemption

  // Natural persons — below the threshold by default, but see §77/1 above.
  sole_proprietor: false,
  individual: false,

  // Legally barred from earning revenue in Thailand (they still hold a TIN for
  // withholding tax). Inferred from §77/1-§77/2, not a direct RD ruling — so the
  // admin can override.
  representative_office: false,

  // §81(1)(ท) exempts ministries/departments remitting all receipts to the state.
  government: false,

  // NO DEFAULT. See the docblock above — TSCC is one of these.
  association: null,
  foundation: null,
};
