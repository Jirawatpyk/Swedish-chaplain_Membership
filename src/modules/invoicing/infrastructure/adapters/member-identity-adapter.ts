/**
 * T049 — Member identity adapter (F4).
 *
 * Reads member + primary contact from the F3 tables and builds a
 * `MemberIdentitySnapshot` at issue time. Uses raw SQL for the
 * `FOR UPDATE` row lock that Drizzle's select builder does not expose
 * directly (FR-037 archive-race guard).
 *
 * NOTE: F3 `members` table has no dedicated `address` column — we
 * populate the snapshot's `address` field from ISO country code until
 * a full-address extension lands in Phase 10. The primary contact's
 * first/last name + email come from `contacts`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '../../application/ports/member-identity-port';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import type { TenantTx } from '@/lib/db';
import { makeMemberIdentitySnapshot } from '../../domain/value-objects/member-identity-snapshot';

export const memberIdentityAdapter: MemberIdentityPort = {
  async getForIssue(
    txUnknown,
    tenantId: string,
    memberId: string,
    opts?: { readonly forUpdate?: boolean },
  ): Promise<MemberIdentityView | null> {
    const tx = txUnknown as TenantTx;
    const forUpdate = opts?.forUpdate === true;

    const memberRows = (await tx.execute(
      forUpdate
        ? sql`
            SELECT member_id, company_name, tax_id, country, status, archived_at,
                   registration_date, registration_fee_paid
              FROM members
             WHERE tenant_id = ${tenantId} AND member_id = ${memberId}
             FOR UPDATE
          `
        : sql`
            SELECT member_id, company_name, tax_id, country, status, archived_at,
                   registration_date, registration_fee_paid
              FROM members
             WHERE tenant_id = ${tenantId} AND member_id = ${memberId}
          `,
    )) as unknown as Array<{
      member_id: string;
      company_name: string;
      tax_id: string | null;
      country: string;
      status: string;
      archived_at: Date | null;
      registration_date: Date | string;
      registration_fee_paid: boolean;
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
      registrationDate: regDate,
      registrationFeePaid: m.registration_fee_paid,
      snapshot: makeMemberIdentitySnapshot({
        legal_name: m.company_name,
        tax_id: m.tax_id,
        address: m.country,
        primary_contact_name: primaryContact
          ? `${primaryContact.firstName} ${primaryContact.lastName}`
          : '',
        primary_contact_email: primaryContact?.email ?? '',
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
