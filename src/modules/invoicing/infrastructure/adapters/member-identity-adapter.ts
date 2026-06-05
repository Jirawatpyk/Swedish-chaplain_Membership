/**
 * T049 — Member identity adapter (F4).
 *
 * Reads member + primary contact from the F3 tables and builds a
 * `MemberIdentitySnapshot` at issue time. Uses raw SQL for the
 * `FOR UPDATE` row lock that Drizzle's select builder does not expose
 * directly (FR-037 archive-race guard).
 *
 * The snapshot's `address` is composed from the F3 `members` structured
 * postal columns (`address_line1/2`, `city`, `province`, `postal_code`,
 * `country`) via `composeBuyerAddress`, so the buyer block satisfies the
 * Thai Revenue Code §86/§87 full-address requirement (not just a country
 * code — the prior stub). The primary contact's first/last name + email
 * come from `contacts`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '../../application/ports/member-identity-port';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
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
    // individual) so issue-invoice can require a tax_id on company tax invoices.
    // Cross-module raw SQL — same posture this adapter already takes when it
    // reads the F3 `members` table from the invoicing module (RLS still scopes
    // both tables via the per-tenant `tx`); the F2 plans barrel exposes no
    // per-issue scope lookup. `FOR UPDATE OF m` locks ONLY the members row (the
    // archive-race guard), never the plan catalogue.
    const memberRows = (await tx.execute(
      forUpdate
        ? sql`
            SELECT m.member_id, m.company_name, m.tax_id, m.country, m.status,
                   m.address_line1, m.address_line2, m.city, m.province, m.postal_code,
                   m.archived_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
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
                   m.address_line1, m.address_line2, m.city, m.province, m.postal_code,
                   m.archived_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
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
      city: string | null;
      province: string | null;
      postal_code: string | null;
      status: string;
      archived_at: Date | null;
      registration_date: Date | string;
      registration_fee_paid: boolean;
      member_number: number | null;
      member_type_scope: 'company' | 'individual' | 'both' | null;
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
