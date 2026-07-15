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
import { and, eq, sql } from 'drizzle-orm';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '../../application/ports/member-identity-port';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { asMemberNumber, formatMemberNumber } from '@/modules/members';
import type { TenantTx } from '@/lib/db';
import { makeMemberIdentitySnapshot } from '../../domain/value-objects/member-identity-snapshot';
import { composeBuyerAddress } from './compose-buyer-address';

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
                   m.archived_at, m.registration_date, m.registration_fee_paid,
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
                   m.archived_at, m.registration_date, m.registration_fee_paid,
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
      status: string;
      archived_at: Date | null;
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

    const [primaryContact] = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.memberId, memberId),
          eq(contacts.isPrimary, true),
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

    return {
      memberId,
      isActive: m.status === 'active',
      isArchived: m.archived_at !== null,
      memberTypeScope: m.member_type_scope ?? null,
      registrationDate: regDate,
      registrationFeePaid: m.registration_fee_paid,
      snapshot: makeMemberIdentitySnapshot({
        legal_name: m.company_name,
        tax_id: m.tax_id,
        address: composeBuyerAddress({
          addressLine1: m.address_line1,
          addressLine2: m.address_line2,
          subDistrict: m.sub_district,
          city: m.city,
          province: m.province,
          postalCode: m.postal_code,
          country: m.country,
        }),
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
