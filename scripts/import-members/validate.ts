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
  type PreferredLanguage,
} from './coerce';
import type { MemberTypeScope, TierResolver } from './tier-resolution';

export interface RawRow {
  /** 1-based Excel data-row index — the ONLY cross-reference in the report (no PII). */
  readonly rowIndex: number;
  readonly companyName: string;
  readonly country: string;
  readonly taxId: string;
  readonly tier: string;
  readonly turnover: string;
  readonly registrationDate: string;
  readonly memberLocale: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
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
  readonly country: IsoCountryCode;
  readonly taxId: TaxId | null;
  readonly planId: string;
  readonly memberTypeScope: MemberTypeScope;
  readonly turnoverThb: number | null;
  readonly registrationDate: Date;
  readonly preferredLocale: PreferredLanguage | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
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
  return Number.isFinite(n) ? n : null;
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

  // Rule 2 (cross-import email uniqueness): tally lowercased valid emails.
  // Skip rows with a blank company name — they are errored + not grouped into a
  // member, so they must not bump a real member's email count (false duplicate).
  const emailCounts = new Map<string, number>();
  for (const r of rows) {
    if (normCompanyKey(r.companyName).length === 0) continue;
    const e = asEmail(r.contactEmail);
    if (e.ok) emailCounts.set(e.value, (emailCounts.get(e.value) ?? 0) + 1);
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
  let validContacts = 0;

  for (const groupRows of groups.values()) {
    const head = groupRows[0]!;
    const memberErrorsBefore = issues.filter((i) => i.severity === 'error').length;

    // --- Member-level fields (rules 3,4,5,8) — taken from the group head ---
    const country = countryNameToCode(head.country);
    if (!country.ok) err(head.rowIndex, 'country', 'unresolved');

    const tier = tierResolver.resolve(head.tier);
    if (!tier.ok) err(head.rowIndex, 'tier', 'unmapped');

    const regDate = parseGregorianDate(head.registrationDate);
    if (!regDate.ok) err(head.rowIndex, 'registrationDate', regDate.error.code);

    // Rule 8: tax_id required for company-scope members; TH company → checksum.
    let taxId: TaxId | null = null;
    if (tier.ok && country.ok) {
      const scope = tier.value.memberTypeScope;
      const rawTax = head.taxId.trim();
      if (scope === 'company') {
        if (rawTax.length === 0) {
          err(head.rowIndex, 'taxId', 'required_for_company');
        } else {
          const parsed = asTaxId(rawTax, country.value);
          if (!parsed.ok) err(head.rowIndex, 'taxId', parsed.error.code);
          else taxId = parsed.value;
        }
      } else if (rawTax.length > 0) {
        const parsed = asTaxId(rawTax, country.value);
        if (!parsed.ok) err(head.rowIndex, 'taxId', parsed.error.code);
        else taxId = parsed.value;
      }
    }

    const turnoverThb = parseTurnover(head.turnover);
    if (head.turnover.trim().length > 0 && turnoverThb === null) {
      warn(head.rowIndex, 'turnover', 'not_a_number');
    }

    const memberLocale = coercePreferredLanguage(head.memberLocale);
    if (head.memberLocale.trim().length > 0 && memberLocale === null) {
      warn(head.rowIndex, 'memberLocale', 'unknown_language');
    }

    // Member-field consistency across the group. Rows of one company SHOULD share
    // member-level values; a disagreement on country/taxId/tier is a strong signal
    // that two DISTINCT companies share a display name and were wrongly merged into
    // one member (only the head row's values survive). Warn so the operator can
    // split them — we cannot auto-resolve without a stable member key (item 6).
    const norm = (s: string): string => s.trim().toLowerCase();
    for (const r of groupRows.slice(1)) {
      for (const field of ['country', 'taxId', 'tier'] as const) {
        const a = norm(head[field]);
        const b = norm(r[field]);
        if (b.length > 0 && a.length > 0 && a !== b) {
          warn(r.rowIndex, field, 'member_field_mismatch');
        }
      }
    }

    // --- Contacts (rules 1,2,6,7) — one per row ---
    const contacts: ValidatedContact[] = [];
    let primaryCount = 0;
    for (const r of groupRows) {
      const email = asEmail(r.contactEmail);
      if (!email.ok) {
        err(r.rowIndex, 'contactEmail', email.error.code);
        continue;
      }
      if ((emailCounts.get(email.value) ?? 0) > 1) {
        err(r.rowIndex, 'contactEmail', 'duplicate_in_import');
      }
      if (blankToNull(r.contactFirstName) === null) err(r.rowIndex, 'contactFirstName', 'required');
      if (blankToNull(r.contactLastName) === null) err(r.rowIndex, 'contactLastName', 'required');

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
        country: country.value,
        taxId,
        planId: tier.value.planId,
        memberTypeScope: tier.value.memberTypeScope,
        turnoverThb,
        registrationDate: regDate.value,
        preferredLocale: memberLocale,
        city: blankToNull(head.city),
        province: blankToNull(head.province),
        postalCode: blankToNull(head.postalCode),
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
