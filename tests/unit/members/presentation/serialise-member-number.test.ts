/**
 * ADMIN-3 (055-member-number) — serialiseMember and serialiseDirectoryRow
 * must emit `member_number` in their JSON shapes.
 */
import { describe, expect, it } from 'vitest';
import { serialiseDirectoryRow, serialiseMember } from '@/app/api/members/_serialise';
import { asMemberNumber } from '@/modules/members';
import type { Member, DirectoryRow } from '@/modules/members';

// Minimal Member fixture — only the fields needed by serialiseMember.
function makeTestMember(overrides: Partial<Pick<Member, 'memberNumber'>> = {}): Member {
  return {
    tenantId: 'test-tenant' as Member['tenantId'],
    memberId: '11111111-1111-4111-8111-111111111111' as Member['memberId'],
    memberNumber: overrides.memberNumber ?? asMemberNumber(1),
    companyName: 'Test Co',
    legalEntityType: null,
    country: 'TH' as Member['country'],
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    registeredCapitalThb: null,
    planId: 'corporate' as Member['planId'],
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    subDistrict: null,
    status: 'active',
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function makeTestDirectoryRow(overrides: Partial<Pick<Member, 'memberNumber'>> = {}): DirectoryRow {
  return {
    member: makeTestMember(overrides),
    primaryContact: null,
    planDisplayName: 'Corporate',
    riskScoreBand: null,
    riskScore: null,
  };
}

describe('serialiser maps memberNumber → member_number', () => {
  it('serialiseMember emits member_number', () => {
    const m = makeTestMember({ memberNumber: asMemberNumber(42) });
    expect(serialiseMember(m).member_number).toBe(42);
  });

  it('serialiseDirectoryRow emits member_number', () => {
    const row = makeTestDirectoryRow({ memberNumber: asMemberNumber(7) });
    expect(serialiseDirectoryRow(row).member_number).toBe(7);
  });
});
