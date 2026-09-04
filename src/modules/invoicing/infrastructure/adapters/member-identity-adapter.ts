/**
 * T049 — Member identity adapter (F4).
 *
 * Reads member + primary contact from the F3 tables and builds a
 * `MemberIdentitySnapshot` at issue time. Uses raw SQL for the
 * `FOR UPDATE` row lock that Drizzle's select builder does not expose
 * directly (FR-037 archive-race guard).
 *
 * The snapshot's `address` is composed from the F3 `members` structured
 * postal columns (`address_line1/2`, `sub_district`, `city`, `province`,
 * `postal_code`, `country`) via `composeBuyerAddress`, so the buyer block
 * satisfies the Thai Revenue Code §86/§87 full-address requirement (not
 * just a country code — the prior stub). The primary contact's first/last
 * name + email come from `contacts`.
 */
import { and, eq, sql, isNull } from 'drizzle-orm';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '../../application/ports/member-identity-port';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { asMemberNumber, formatMemberNumber } from '@/modules/members';
import type { TenantTx } from '@/lib/db';
import { makeMemberIdentitySnapshot } from '../../domain/value-objects/member-identity-snapshot';
import {
  composeBuyerAddress,
  type BuyerAddressParts,
} from './compose-buyer-address';

export const memberIdentityAdapter: MemberIdentityPort = {
  async getForIssue(
    txUnknown,
    tenantId: string,
    memberId: string,
    opts?: { readonly forUpdate?: boolean },
  ): Promise<MemberIdentityView | null> {
    const tx = txUnknown as TenantTx;
    const forUpdate = opts?.forUpdate === true;

    // S1-P1-16: LEFT JOIN the F2 plan to read `member_type_scope` (company vs
    // individual) onto the identity snapshot for reference. NOTE: issue-invoice
    // does NOT gate on it — the former company `tax_id_required` block was
    // removed 2026-06-12 (a §86/4 membership invoice issues regardless of TIN;
    // see member-identity-port.ts `memberTypeScope`). The join is retained only
    // to populate the view's `memberTypeScope` field (a sibling of `snapshot`,
    // not part of the `MemberIdentitySnapshot` VO).
    // Cross-module raw SQL — same posture this adapter already takes when it
    // reads the F3 `members` table from the invoicing module (RLS still scopes
    // both tables via the per-tenant `tx`); the F2 plans barrel exposes no
    // per-issue scope lookup. `FOR UPDATE OF m` locks ONLY the members row (the
    // archive-race guard), never the plan catalogue.
    const memberRows = (await tx.execute(
      forUpdate
        ? sql`
            SELECT m.member_id, m.company_name, m.tax_id, m.country, m.status,
                   m.address_line1, m.address_line2, m.sub_district, m.city, m.province, m.postal_code,
                   m.billing_address_line1, m.billing_address_line2, m.billing_sub_district,
                   m.billing_city, m.billing_province, m.billing_postal_code, m.billing_country,
                   m.archived_at, m.erased_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
                   m.is_vat_registered, m.is_head_office, m.branch_code,
                   COALESCE(
                     (SELECT s.member_number_prefix
                        FROM tenant_member_settings s
                       WHERE s.tenant_id = m.tenant_id),
                     'M'
                   ) AS member_number_prefix,
                   mp.member_type_scope
              FROM members m
              LEFT JOIN membership_plans mp
                ON mp.tenant_id = m.tenant_id
               AND mp.plan_id = m.plan_id
               AND mp.plan_year = m.plan_year
             WHERE m.tenant_id = ${tenantId} AND m.member_id = ${memberId}
             FOR UPDATE OF m
          `
        : sql`
            SELECT m.member_id, m.company_name, m.tax_id, m.country, m.status,
                   m.address_line1, m.address_line2, m.sub_district, m.city, m.province, m.postal_code,
                   m.billing_address_line1, m.billing_address_line2, m.billing_sub_district,
                   m.billing_city, m.billing_province, m.billing_postal_code, m.billing_country,
                   m.archived_at, m.erased_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
                   m.is_vat_registered, m.is_head_office, m.branch_code,
                   COALESCE(
                     (SELECT s.member_number_prefix
                        FROM tenant_member_settings s
                       WHERE s.tenant_id = m.tenant_id),
                     'M'
                   ) AS member_number_prefix,
                   mp.member_type_scope
              FROM members m
              LEFT JOIN membership_plans mp
                ON mp.tenant_id = m.tenant_id
               AND mp.plan_id = m.plan_id
               AND mp.plan_year = m.plan_year
             WHERE m.tenant_id = ${tenantId} AND m.member_id = ${memberId}
          `,
    )) as unknown as Array<{
      member_id: string;
      company_name: string;
      tax_id: string | null;
      country: string;
      address_line1: string | null;
      address_line2: string | null;
      sub_district: string | null;
      city: string | null;
      province: string | null;
      postal_code: string | null;
      // member-billing-address (0284) — the optional tax-document address
      // group. Present in BOTH SELECT arms above (see the two-arms WARNING
      // below); `billing_address_line1 IS NOT NULL` ⟺ the group is set.
      billing_address_line1: string | null;
      billing_address_line2: string | null;
      billing_sub_district: string | null;
      billing_city: string | null;
      billing_province: string | null;
      billing_postal_code: string | null;
      billing_country: string | null;
      status: string;
      archived_at: Date | null;
      // COMP-1 / PDPA — erasure is ORTHOGONAL to archive (`scrubPiiInTx` stamps
      // `erased_at` but deliberately leaves `status`/`archived_at` untouched), so
      // the `isArchived` gate below does NOT catch an erased member. Read it here
      // so the issue path can fail closed on a redacted buyer identity.
      erased_at: Date | null;
      registration_date: Date | string;
      registration_fee_paid: boolean;
      member_number: number | null;
      // 055-member-number — the tenant's display prefix, resolved RLS-safely in
      // the SELECT (sub-select on tenant_member_settings under the per-tenant
      // `tx`, so it only ever reads the current tenant's row). COALESCE → 'M' is
      // the table-default fallback for a tenant with no explicit settings row.
      // The two `COALESCE(..., 'M')` SQL literals above are the SQL mirror of
      // members-domain `DEFAULT_MEMBER_NUMBER_PREFIX` — keep them in sync.
      member_number_prefix: string;
      member_type_scope: 'company' | 'individual' | 'both' | null;
      // 088 US3 (T030 / FR-008) — §86/4 buyer-branch source columns. The branch
      // LINE is drawn only for a VAT-registrant buyer, read from the RECORDED
      // `is_vat_registered` column (059 / PR-A: it used to be GUESSED from
      // `legal_entity_type`). All three are NOT NULL except `branch_code`, a
      // nullable char(5); `is_vat_registered` + `is_head_office` DEFAULT
      // false/true respectively.
      //
      // WARNING: the `as unknown as` cast above means the compiler checks NEITHER
      // direction — a column named here but absent from the SELECTs yields
      // `undefined` at runtime, and vice versa. There are TWO SELECT arms (the
      // `FOR UPDATE` lock and the plain read) and they must be edited in
      // lockstep. `tests/integration/invoicing/member-identity-branch.test.ts`
      // exercises BOTH arms; it is the only thing that can catch drift here.
      is_vat_registered: boolean;
      is_head_office: boolean;
      branch_code: string | null;
    }>;

    const m = memberRows[0];
    if (!m) return null;

    // 108 FR-009 — state the whole primary-contact rule here. `removed_at IS
    // NULL` is implied today by migration 0009's CHECK
    // `contacts_primary_not_removed` (a removed row cannot stay primary), so
    // this is belt-and-braces rather than a behaviour change; it keeps every
    // primary-contact read in the money path spelling out the same predicate
    // instead of half of it.
    const [primaryContact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.memberId, memberId),
          eq(contacts.isPrimary, true),
          isNull(contacts.removedAt),
        ),
      )
      .limit(1);

    const regDate =
      m.registration_date instanceof Date
        ? m.registration_date.toISOString().slice(0, 10)
        : String(m.registration_date).slice(0, 10);

    // 055-member-number — compute the FORMATTED display string at issue time so
    // it freezes onto the snapshot (FR-038 immutability). `formatMemberNumber`
    // lives in the members public barrel (Domain VO). The `!== null` guard keeps
    // the (pre-backfill / non-member) no-number path at null. When a number IS
    // present, `asMemberNumber` throws on a corrupt (<=0 / non-int) value — and
    // because this runs INSIDE the issue-invoice / credit-note tx, that throw
    // ABORTS tax-doc issuance. This is a DELIBERATE issue-blocking fail-loud: we
    // must NOT issue a §86/4 tax invoice off a corrupt buyer identity. The DB
    // `CHECK (member_number > 0)` makes a corrupt live value near-unreachable, so
    // this is a backstop, not an expected branch.
    const memberNumberDisplay =
      m.member_number !== null
        ? formatMemberNumber(m.member_number_prefix, asMemberNumber(m.member_number))
        : null;

    // member-billing-address (0284) — ONE switch point: when the member
    // carries a billing address (⟺ billing_address_line1 IS NOT NULL, the
    // group invariant), the §86/4 buyer block composes from the BILLING
    // group (their ภ.พ.20-registered address, incl. its OWN country);
    // otherwise from the company address exactly as before. SAME composer
    // either way — no second formatting path. Credit notes inherit
    // `original.memberIdentitySnapshot` verbatim (issue-credit-note.ts), so
    // this is the only compose site. EXISTING issued documents are
    // untouched: the snapshot is FROZEN at issue (FR-038 immutability) —
    // adding a billing address later never rewrites a previously-issued
    // invoice/receipt.
    let buyerAddressParts: BuyerAddressParts;
    if (m.billing_address_line1 !== null) {
      if (m.billing_country === null) {
        // LOW-1 (tax review) — DELIBERATE issue-blocking fail-loud, same
        // posture as the `asMemberNumber` corrupt-identity throw above: the
        // `members_billing_address_group_ck` CHECK guarantees a non-null
        // country whenever line1 is set, so this is unreachable off a live
        // row. A silent `?? m.country` fallback here would print a MIXED
        // address (billing street under the company's country) on a §86/4
        // tax document; because this runs INSIDE the issue tx, the throw
        // aborts issuance instead.
        throw new Error(
          `corrupt billing address group for member ${m.member_id}: ` +
            'billing_address_line1 is set but billing_country is NULL ' +
            '(members_billing_address_group_ck should make this unreachable)',
        );
      }
      buyerAddressParts = {
        addressLine1: m.billing_address_line1,
        addressLine2: m.billing_address_line2,
        subDistrict: m.billing_sub_district,
        city: m.billing_city,
        province: m.billing_province,
        postalCode: m.billing_postal_code,
        country: m.billing_country,
      };
    } else {
      buyerAddressParts = {
        addressLine1: m.address_line1,
        addressLine2: m.address_line2,
        subDistrict: m.sub_district,
        city: m.city,
        province: m.province,
        postalCode: m.postal_code,
        country: m.country,
      };
    }

    return {
      memberId,
      isActive: m.status === 'active',
      isArchived: m.archived_at !== null,
      isErased: m.erased_at !== null,
      memberTypeScope: m.member_type_scope ?? null,
      registrationDate: regDate,
      registrationFeePaid: m.registration_fee_paid,
      snapshot: makeMemberIdentitySnapshot({
        legal_name: m.company_name,
        tax_id: m.tax_id,
        // member-billing-address (0284) — billing-vs-company switch resolved
        // (with its LOW-1 fail-loud guard) into `buyerAddressParts` above.
        address: composeBuyerAddress(buyerAddressParts),
        primary_contact_name: primaryContact
          ? `${primaryContact.firstName} ${primaryContact.lastName}`
          : '',
        primary_contact_email: primaryContact?.email ?? '',
        // 055-member-number — surface the buyer's member number on the snapshot
        // pinned at issue (FR-038). A live member always has a non-null number
        // post-backfill; the `?? null` is defensive only (pre-backfill window).
        member_number: m.member_number ?? null,
        // The FORMATTED display string the PDF renders (`SCCM-0042`) — frozen
        // here so a later prefix/member change never mutates an issued document.
        member_number_display: memberNumberDisplay,
        // 088 US3 (T030 / FR-008) — §86/4 Head-Office / Branch particular, pinned
        // at issue. The buyer branch LINE renders only for a VAT-registrant buyer
        // (never keyed on `buyerHasTin`).
        //
        // Was: `isVatRegistrantEntityType(m.legal_entity_type)` — a GUESS ("any
        // string that is not 'individual'"), wrong in law (VAT registration
        // follows turnover, not legal form) and, because `legal_entity_type` was
        // NULL on every row, false for EVERYONE — so no member ever received the
        // mandatory branch particular. Now: the recorded fact. See migration 0250.
        buyer_is_vat_registrant: m.is_vat_registered,
        // Head office (default) / branch pair, taken from the member row. The
        // `members_branch_pairing_ck` CHECK guarantees they are consistent
        // (head office ⇒ NULL code; branch ⇒ 5-digit code), matching the
        // snapshot VO's superRefine.
        buyer_is_head_office: m.is_head_office ?? true,
        buyer_branch_code: m.branch_code ?? null,
      }),
    };
  },

  async markRegistrationFeePaid(
    txUnknown,
    tenantId: string,
    memberId: string,
  ): Promise<void> {
    const tx = txUnknown as TenantTx;
    // Tenant-scoped UPDATE — RLS enforces the tenant_id predicate
    // even if it's dropped here, but we include it explicitly as
    // belt-and-suspenders and for query-planner clarity. Idempotent:
    // once true, subsequent calls match 0 rows.
    await tx.execute(sql`
      UPDATE members
         SET registration_fee_paid = TRUE,
             updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND member_id = ${memberId}
         AND registration_fee_paid = FALSE
    `);
  },
};
