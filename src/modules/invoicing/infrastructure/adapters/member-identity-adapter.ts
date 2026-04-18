/**
 * T049 — Member identity adapter (F4).
 *
 * Reads member + primary contact via the members public barrel
 * (`@/modules/members`) + a direct query for row lock when needed.
 *
 * Builds a `MemberIdentitySnapshot` at issue time.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '../../application/ports/member-identity-port';
// NOTE: `members` table is read via raw SQL below (needs FOR UPDATE
// which Drizzle's select builder does not expose directly). `contacts`
// read goes through the builder as it does not need a row lock.
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
    // FOR UPDATE row-lock on the member when caller asks — FR-037
    // archive-race guard.
    const forUpdate = opts?.forUpdate === true;

    const memberRows = (await tx.execute(
      forUpdate
        ? sql`
            SELECT member_id, company_name, tax_id, address, status, archived_at
              FROM members
             WHERE tenant_id = ${tenantId} AND member_id = ${memberId}
             FOR UPDATE
          `
        : sql`
            SELECT member_id, company_name, tax_id, address, status, archived_at
              FROM members
             WHERE tenant_id = ${tenantId} AND member_id = ${memberId}
          `,
    )) as unknown as Array<{
      member_id: string;
      company_name: string;
      tax_id: string | null;
      address: string | null;
      status: string;
      archived_at: Date | null;
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

    return {
      memberId,
      isActive: m.status === 'active',
      isArchived: m.archived_at !== null,
      snapshot: makeMemberIdentitySnapshot({
        legal_name: m.company_name,
        tax_id: m.tax_id,
        address: m.address ?? '',
        primary_contact_name: primaryContact
          ? `${primaryContact.firstName} ${primaryContact.lastName}`
          : '',
        primary_contact_email: primaryContact?.email ?? '',
      }),
    };
  },
};
