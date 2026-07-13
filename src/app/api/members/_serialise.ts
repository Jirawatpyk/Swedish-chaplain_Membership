/**
 * Serializers for /api/members payloads — convert Domain types
 * (branded UserId / Email / etc.) to plain JSON shape per
 * contracts/members-api.md.
 */

import type { Member } from '@/modules/members';
import type { Contact } from '@/modules/members';
import type { DirectoryRow } from '@/modules/members';

export function serialiseMember(m: Member) {
  return {
    member_id: m.memberId,
    member_number: m.memberNumber,
    company_name: m.companyName,
    legal_entity_type: m.legalEntityType,
    country: m.country,
    tax_id: m.taxId,
    // 088 US3 — §86/4 Head-Office / Branch particular (admin API only; the
    // member self-service portal MUST NOT expose these tax-critical fields).
    // Guarded `?? true` / `?? null` for a hand-built Member that omits them.
    is_head_office: m.isHeadOffice ?? true,
    branch_code: m.branchCode ?? null,
    website: m.website,
    description: m.description,
    address_line1: m.addressLine1,
    address_line2: m.addressLine2,
    city: m.city,
    province: m.province,
    postal_code: m.postalCode,
    sub_district: m.subDistrict,
    founded_year: m.foundedYear,
    turnover_thb: m.turnoverThb,
    registered_capital_thb: m.registeredCapitalThb,
    plan_id: m.planId,
    plan_year: m.planYear,
    registration_date: m.registrationDate.toISOString().slice(0, 10),
    registration_fee_paid: m.registrationFeePaid,
    status: m.status,
    archived_at: m.archivedAt?.toISOString() ?? null,
    last_activity_at: m.lastActivityAt?.toISOString() ?? null,
    notes: m.notes,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
  };
}

export function serialiseContact(
  c: Contact,
  opts: { readonly includeDateOfBirth?: boolean } = {},
) {
  return {
    contact_id: c.contactId,
    member_id: c.memberId,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    phone: c.phone,
    role_title: c.roleTitle,
    preferred_language: c.preferredLanguage,
    is_primary: c.isPrimary,
    linked_user_id: c.linkedUserId,
    ...(opts.includeDateOfBirth && {
      date_of_birth: c.dateOfBirth?.toISOString().slice(0, 10) ?? null,
    }),
    removed_at: c.removedAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function serialiseDirectoryRow(row: DirectoryRow) {
  return {
    member_id: row.member.memberId,
    member_number: row.member.memberNumber,
    company_name: row.member.companyName,
    country: row.member.country,
    plan_id: row.member.planId,
    plan_year: row.member.planYear,
    // Denormalized English display name from the correlated subquery
    // in searchDirectory — avoids a client-side slug → label map.
    plan_display_name: row.planDisplayName,
    status: row.member.status,
    member_risk_flag: null, // F8 placeholder (FR-001)
    last_activity_at: row.member.lastActivityAt?.toISOString() ?? null,
    primary_contact: row.primaryContact
      ? {
          contact_id: row.primaryContact.contactId,
          first_name: row.primaryContact.firstName,
          last_name: row.primaryContact.lastName,
          email: row.primaryContact.email,
        }
      : null,
  };
}

