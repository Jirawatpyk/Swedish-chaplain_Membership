/**
 * Stage-3 member importer — per-member/contact validation pass (spec § 3).
 *
 * Pure + framework-free (spec § 8): takes column-mapped raw rows + a TierResolver,
 * groups rows into members (by normalized company name; one Excel row = one
 * contact), runs the 8 spec § 3 rules, and returns:
 *   - `members`  — fully-valid members ready for the commit phase (in-memory only;
 *                  may carry company name + emails — NEVER written to the report file)
 *   - `issues`   — report-safe { rowIndex, field, code, severity } (NO PII — spec § 7)
 *   - `tierHistogram` + `stats`
 *
 * The DB-side checks (email-already-in-DB dedupe; soft-deleted reactivation) are
 * layered in the CLI/commit phase — this module covers in-memory validation only.
 */
import { asEmail, type Email } from '@/modules/members/domain/value-objects/email';
import { asPhone, type Phone } from '@/modules/members/domain/value-objects/phone';
import { asTaxId, type TaxId } from '@/modules/members/domain/value-objects/tax-id';
import { type IsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code';
import {
  countryNameToCode,
  parseGregorianDate,
  coercePreferredLanguage,
  normalizeTaxIdCell,
  coerceMemberStatus,
  type PreferredLanguage,
} from './coerce';
import { coerceLegalEntityType } from './entity-type';
import { VAT_DEFAULT_BY_CODE, type LegalEntityTypeCode } from '@/modules/members';
import type { MemberTypeScope, TierResolver } from './tier-resolution';

export interface RawRow {
  /** 1-based Excel data-row index — the ONLY cross-reference in the report (no PII). */
  readonly rowIndex: number;
  readonly companyName: string;
  readonly legalEntityType: string;
  readonly country: string;
  readonly taxId: string;
  readonly tier: string;
  readonly turnover: string;
  readonly registeredCapital: string;
  readonly website: string;
  readonly foundedYear: string;
  readonly description: string;
  readonly registrationDate: string;
  readonly memberLocale: string;
  readonly status: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly contactFirstName: string;
  readonly contactLastName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly contactRole: string;
  readonly contactLanguage: string;
  readonly isPrimary: string;
}

export interface ValidatedContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: Email;
  readonly phone: Phone | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: PreferredLanguage;
  readonly isPrimary: boolean;
  readonly rowIndex: number;
}

export interface ValidatedMember {
  readonly companyName: string;
  readonly legalEntityType: LegalEntityTypeCode | null;
  readonly isVatRegistered: boolean;
  readonly status: 'active' | 'inactive';
  readonly country: IsoCountryCode;
  readonly taxId: TaxId | null;
  readonly planId: string;
  readonly memberTypeScope: MemberTypeScope;
  readonly turnoverThb: number | null;
  readonly registeredCapitalThb: number | null;
  readonly foundedYear: number | null;
  readonly website: string | null;
  readonly description: string | null;
  readonly registrationDate: Date;
  readonly preferredLocale: PreferredLanguage | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly contacts: readonly ValidatedContact[];
  readonly rowIndices: readonly number[];
}

export type IssueSeverity = 'error' | 'warning';

/** Report-safe issue — NO PII (spec § 7). Operator cross-references rowIndex to the Excel. */
export interface RowIssue {
  readonly rowIndex: number;
  readonly field: string;
  readonly code: string;
  readonly severity: IssueSeverity;
}

export interface ValidationReport {
  readonly members: readonly ValidatedMember[];
  readonly issues: readonly RowIssue[];
  readonly tierHistogram: Readonly<Record<string, number>>;
  /** Coerced entity type per member GROUP (code / 'null' / 'unmapped'), across ALL
   *  groups regardless of member validity — the coercer's verification signal. */
  readonly entityTypeHistogram: Readonly<Record<string, number>>;
  readonly stats: {
    readonly totalRows: number;
    readonly memberGroups: number;
    readonly validMembers: number;
    readonly validContacts: number;
    readonly errorCount: number;
    readonly warningCount: number;
  };
}

const PRIMARY_TRUE = new Set(['yes', 'y', 'true', '1', 'primary', 'x']);

function normCompanyKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function blankToNull(s: string): string | null {
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function parseTurnover(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, '');
  if (t.length === 0) return null;
  const n = Number(t);
  // turnover_thb / registered_capital_thb are NON-NEGATIVE bigints (whole baht,
  // DB CHECK >= 0). A value flowing raw into the `--commit` INSERT that is not a
  // whole, non-negative, in-range integer would crash it and roll back the whole
  // all-or-nothing import. Handle each shape so the row still contributes its data
  // instead of degrading to null:
  //   - FRACTIONAL ("5000000.50")        → ROUND to the nearest whole baht. The real
  //     TSCC sheet carries .xx satang on most turnover/capital rows; dropping them
  //     silently lost 117/148 real figures. Satang is not stored, so rounding is
  //     the faithful whole-baht value.
  //   - NEGATIVE ("-5000000")            → null + warning (violates the CHECK).
  //   - OVER-RANGE (> MAX_SAFE_INTEGER)  → null + warning (JS precision loss +
  //     Postgres `bigint out of range`). MAX_SAFE_INTEGER ≈ 9.0e15 is well above
  //     any real annual turnover and safely below bigint max 9.2e18.
  //   - NaN ("N/A")                       → null + warning.
  if (!Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function parseFoundedYear(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  // members.founded_year is a nullable plain integer year. Guard a sane range so
  // a stray turnover / BE / date cell degrades to null (+ warning) instead of
  // storing nonsense.
  return Number.isInteger(n) && n >= 1800 && n <= 2100 ? n : null;
}

/** Validate all rows; group by member; apply spec § 3 rules 1-8. */
export function validateRows(
  rows: readonly RawRow[],
  tierResolver: TierResolver,
): ValidationReport {
  const issues: RowIssue[] = [];
  const err = (rowIndex: number, field: string, code: string): void => {
    issues.push({ rowIndex, field, code, severity: 'error' });
  };
  const warn = (rowIndex: number, field: string, code: string): void => {
    issues.push({ rowIndex, field, code, severity: 'warning' });
  };

  // Rule 2 (cross-import email uniqueness) — code-review #2: scope by COMPANY.
  // Map each lowercased valid email → the set of DISTINCT company keys it
  // appears under. An email under ≥2 distinct companies is a genuine
  // cross-member collision (error). The same email repeated WITHIN one company
  // group is an intra-member data-entry duplicate (paste error) — handled in
  // the per-group contacts loop below as a warn + dedupe, NOT an error that
  // drops the whole legitimate member. Blank-company rows are skipped (they
  // error on `companyName` + are not grouped, so must not bump a real count).
  const emailCompanies = new Map<string, Set<string>>();
  for (const r of rows) {
    const ck = normCompanyKey(r.companyName);
    if (ck.length === 0) continue;
    const e = asEmail(r.contactEmail);
    if (e.ok) {
      const set = emailCompanies.get(e.value) ?? new Set<string>();
      set.add(ck);
      emailCompanies.set(e.value, set);
    }
  }

  // Group rows into members by normalized company name.
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) {
    const key = normCompanyKey(r.companyName);
    if (key.length === 0) {
      err(r.rowIndex, 'companyName', 'required');
      continue;
    }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const members: ValidatedMember[] = [];
  const tierHistogram: Record<string, number> = {};
  const entityTypeHistogram: Record<string, number> = {};
  let validContacts = 0;

  for (const groupRows of groups.values()) {
    const head = groupRows[0]!;
    const memberErrorsBefore = issues.filter((i) => i.severity === 'error').length;

    // --- Member-level fields (rules 3,4,5,8) — taken from the group head ---
    const country = countryNameToCode(head.country);
    if (!country.ok) err(head.rowIndex, 'country', 'unresolved');

    const tier = tierResolver.resolve(head.tier);
    if (!tier.ok) err(head.rowIndex, 'tier', 'unmapped');

    // Entity type (Task 7). blank/N/A → null; unmapped → per-row error (excludes
    // the member — a wrong legal form must never be guessed).
    const entityTypeRes = coerceLegalEntityType(head.legalEntityType);
    const legalEntityType: LegalEntityTypeCode | null = entityTypeRes.ok
      ? entityTypeRes.value
      : null;
    if (!entityTypeRes.ok) err(head.rowIndex, 'legalEntityType', 'unmapped');
    {
      // Count EVERY group's coerced entity type (code / 'null' / 'unmapped'),
      // independent of member validity — this verifies the coercer against the
      // sheet (expect 111/15/7/5/2 + 10 null on the real TSCC data).
      const key = entityTypeRes.ok ? (legalEntityType ?? 'null') : 'unmapped';
      entityTypeHistogram[key] = (entityTypeHistogram[key] ?? 0) + 1;
    }

    const regDate = parseGregorianDate(head.registrationDate);
    if (!regDate.ok) err(head.rowIndex, 'registrationDate', regDate.error.code);

    // Rule 8 (RELAXED 2026-07-10): tax_id is OPTIONAL for every scope. The DB
    // column `members.tax_id` is nullable, and Thai tax law only needs the buyer
    // TIN on a §86/4 tax invoice issued to a VAT-registrant buyer — collected at
    // invoice-issue time, NOT at membership entry. Foreign company members
    // legitimately have no Thai TIN. So a company with no tax_id gets a WARNING
    // (operator can backfill later) instead of a blocking error. When a tax_id IS
    // supplied it is still checksum-validated for either scope.
    let taxId: TaxId | null = null;
    if (tier.ok && country.ok) {
      const scope = tier.value.memberTypeScope;
      const rawTax = normalizeTaxIdCell(head.taxId, country.value); // pad-13 + N/A→''
      if (rawTax.length === 0) {
        if (scope === 'company') warn(head.rowIndex, 'taxId', 'missing_for_company');
      } else {
        const parsed = asTaxId(rawTax, country.value);
        if (!parsed.ok) err(head.rowIndex, 'taxId', parsed.error.code);
        else taxId = parsed.value;
      }
    }

    // 059/PR-A — is_vat_registered = the entity-type DEFAULT, gated on actually
    // having a TIN (the registrant⇒TIN invariant, live on prod, rejects
    // true+null at create). association/foundation have NO safe default → warn.
    const isVatRegistered =
      legalEntityType !== null &&
      VAT_DEFAULT_BY_CODE[legalEntityType] === true &&
      taxId !== null;
    if (legalEntityType !== null && VAT_DEFAULT_BY_CODE[legalEntityType] === null) {
      warn(head.rowIndex, 'legalEntityType', 'vat_default_unknown_confirm');
    }

    const statusValue = coerceMemberStatus(head.status);
    if (head.status.trim().length > 0 && statusValue === null) {
      warn(head.rowIndex, 'status', 'unknown_status_defaulting_active');
    }
    const status = statusValue ?? 'active';

    const turnoverThb = parseTurnover(head.turnover);
    if (head.turnover.trim().length > 0 && turnoverThb === null) {
      warn(head.rowIndex, 'turnover', 'not_a_number');
    }

    const registeredCapitalThb = parseTurnover(head.registeredCapital);
    if (head.registeredCapital.trim().length > 0 && registeredCapitalThb === null) {
      warn(head.rowIndex, 'registeredCapital', 'not_a_number');
    }
    const foundedYear = parseFoundedYear(head.foundedYear);
    if (head.foundedYear.trim().length > 0 && foundedYear === null) {
      warn(head.rowIndex, 'foundedYear', 'not_a_year');
    }

    const memberLocale = coercePreferredLanguage(head.memberLocale);
    if (head.memberLocale.trim().length > 0 && memberLocale === null) {
      warn(head.rowIndex, 'memberLocale', 'unknown_language');
    }

    // Member-field consistency across the group. Rows of one company SHOULD share
    // member-level values; a disagreement signals two DISTINCT companies wrongly
    // merged under a shared display name (only the head row's values survive). Warn
    // so the operator can split them — we cannot auto-resolve without a stable key.
    // Compare RESOLVED values (plan_id / ISO country code), NOT raw cells, so
    // equivalent spellings ("TH" vs "Thailand", "Premium" vs "Premium Corporate")
    // do not false-warn (review items 3/9).
    const headPlanId = tier.ok ? tier.value.planId : null;
    const headCountry = country.ok ? country.value : null;
    const norm = (s: string): string => s.trim().toLowerCase();
    // Only emit mismatch warnings when the HEAD value RESOLVED. If the head's tier/
    // country is blank/unresolvable, the member is already excluded by its own head-row
    // error (headPlanId/headCountry null), so a sibling "mismatch" is pure noise — and
    // worse, it would accuse the sibling that may hold the CORRECT value rather than the
    // bad head (R4 #3/#8/#9). When the head DID resolve, warn on a sibling whose raw cell
    // differs and is not PROVABLY equivalent (same resolved value): equivalent spellings
    // ("TH"≡"Thailand", "Premium"≡"Premium Corporate") stay silent; a genuinely-different
    // value — INCLUDING an unresolvable/garbage one ("Narnia"/"Bronze") — still warns
    // (R3 fix preserved). This mismatch warning is the only signal for a wrongly-merged
    // company, since siblings are never independently resolution-error-checked.
    for (const r of groupRows.slice(1)) {
      if (headPlanId !== null && r.tier.trim().length > 0 && norm(r.tier) !== norm(head.tier)) {
        const rt = tierResolver.resolve(r.tier);
        const equivalent = rt.ok && rt.value.planId === headPlanId;
        if (!equivalent) warn(r.rowIndex, 'tier', 'member_field_mismatch');
      }
      if (headCountry !== null && r.country.trim().length > 0 && norm(r.country) !== norm(head.country)) {
        const rc = countryNameToCode(r.country);
        const equivalent = rc.ok && rc.value === headCountry;
        if (!equivalent) warn(r.rowIndex, 'country', 'member_field_mismatch');
      }
      // code-review #5 — differing NON-BLANK tax IDs within one company group
      // are a strong "two DISTINCT legal entities merged under a shared display
      // name" signal (tier/country can legitimately coincide; a tax ID is
      // unique per entity). Escalate to an ERROR so the operator disambiguates
      // (e.g. suffix one company name) rather than silently importing the head
      // row + losing the sibling company's tax_id/contacts. Compares raw cells
      // (not validated TaxId) so the divergence is caught even when one side is
      // malformed — any genuine difference is enough to refuse the merge.
      if (
        head.taxId.trim().length > 0 &&
        r.taxId.trim().length > 0 &&
        norm(r.taxId) !== norm(head.taxId)
      ) {
        err(r.rowIndex, 'taxId', 'distinct_company_merged');
      }
    }

    // --- Contacts (rules 1,2,6,7) — one per row ---
    const contacts: ValidatedContact[] = [];
    let primaryCount = 0;
    const seenEmailsInMember = new Set<string>();
    for (const r of groupRows) {
      const email = asEmail(r.contactEmail);
      if (!email.ok) {
        err(r.rowIndex, 'contactEmail', email.error.code);
        continue;
      }
      // code-review #2 — cross-member collision: the same email belongs to ≥2
      // DISTINCT companies; we cannot decide which member owns it → error.
      const companies = emailCompanies.get(email.value);
      if (companies && companies.size > 1) {
        err(r.rowIndex, 'contactEmail', 'duplicate_in_import');
      }
      // code-review #2 — intra-member duplicate: the same email repeated WITHIN
      // this one company group (paste/data-entry dup). Warn + dedupe (skip the
      // duplicate contact) so a legitimate single-company member still imports
      // rather than being dropped wholesale.
      if (seenEmailsInMember.has(email.value)) {
        warn(r.rowIndex, 'contactEmail', 'duplicate_contact_in_member');
        continue;
      }
      seenEmailsInMember.add(email.value);
      // code-review #4 — a contact needs AT LEAST ONE name part. A mononym
      // (Thai given-name-only entry, single-display-name company) is legitimate:
      // import it (the missing part stored as '' — `last_name` is NOT NULL but
      // '' is allowed) with a warning, so a real member is never silently
      // dropped. Only a fully-nameless contact errors.
      const hasFirst = blankToNull(r.contactFirstName) !== null;
      const hasLast = blankToNull(r.contactLastName) !== null;
      if (!hasFirst && !hasLast) {
        err(r.rowIndex, 'contactName', 'required');
      } else if (!hasFirst || !hasLast) {
        warn(r.rowIndex, 'contactName', 'mononym_single_name');
      }

      let phone: Phone | null = null;
      const rawPhone = r.contactPhone.trim();
      if (rawPhone.length > 0) {
        const p = asPhone(rawPhone);
        // Spec § 3.6: "normalize to E.164 OR is empty (never store malformed)".
        // A malformed phone (e.g. Thai local '0812345678' without +66) is dropped
        // to null with a WARNING — it must NOT exclude an otherwise-valid member.
        if (!p.ok) warn(r.rowIndex, 'contactPhone', 'dropped_invalid_e164');
        else phone = p.value;
      }

      const lang = coercePreferredLanguage(r.contactLanguage);
      if (r.contactLanguage.trim().length > 0 && lang === null) {
        warn(r.rowIndex, 'contactLanguage', 'unknown_language');
      }

      const isPrimary = PRIMARY_TRUE.has(r.isPrimary.trim().toLowerCase());
      if (isPrimary) primaryCount += 1;

      contacts.push({
        firstName: r.contactFirstName.trim(),
        lastName: r.contactLastName.trim(),
        email: email.value,
        phone,
        roleTitle: blankToNull(r.contactRole),
        preferredLanguage: lang ?? 'en', // contact default 'en' (spec § 2)
        isPrimary,
        rowIndex: r.rowIndex,
      });
    }

    // Rule 1: ≥1 contact with a valid email.
    if (contacts.length === 0) {
      err(head.rowIndex, 'contacts', 'no_valid_contact');
    }

    // Rule 7: exactly one primary. 0 → pick first + warn; >1 → error.
    let normalizedContacts = contacts;
    if (contacts.length > 0) {
      if (primaryCount === 0) {
        warn(head.rowIndex, 'isPrimary', 'none_marked_defaulting_first');
        normalizedContacts = contacts.map((c, i) => (i === 0 ? { ...c, isPrimary: true } : c));
      } else if (primaryCount > 1) {
        for (const c of contacts.filter((x) => x.isPrimary)) {
          err(c.rowIndex, 'isPrimary', 'multiple_primary');
        }
      }
    }

    const memberErrorsAfter = issues.filter((i) => i.severity === 'error').length;
    const memberHasError =
      memberErrorsAfter > memberErrorsBefore || !country.ok || !tier.ok || !regDate.ok;

    if (!memberHasError && country.ok && tier.ok && regDate.ok) {
      tierHistogram[tier.value.planId] = (tierHistogram[tier.value.planId] ?? 0) + 1;
      validContacts += normalizedContacts.length;
      members.push({
        companyName: head.companyName.trim(),
        legalEntityType,
        isVatRegistered,
        status,
        country: country.value,
        taxId,
        planId: tier.value.planId,
        memberTypeScope: tier.value.memberTypeScope,
        turnoverThb,
        registeredCapitalThb,
        foundedYear,
        website: blankToNull(head.website),
        description: blankToNull(head.description),
        registrationDate: regDate.value,
        preferredLocale: memberLocale,
        city: blankToNull(head.city),
        province: blankToNull(head.province),
        postalCode: blankToNull(head.postalCode),
        addressLine1: blankToNull(head.addressLine1),
        addressLine2: blankToNull(head.addressLine2),
        contacts: normalizedContacts,
        rowIndices: groupRows.map((r) => r.rowIndex),
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  return {
    members,
    issues,
    tierHistogram,
    entityTypeHistogram,
    stats: {
      totalRows: rows.length,
      memberGroups: groups.size,
      validMembers: members.length,
      validContacts,
      errorCount,
      warningCount,
    },
  };
}
