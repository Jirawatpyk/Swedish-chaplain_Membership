import { describe, expect, it } from 'vitest';
import {
  archive,
  asMemberId,
  asPlanId,
  asTenantId,
  tryMemberId,
  tryPlanId,
  tryTenantId,
  ARCHIVE_UNDELETE_WINDOW_DAYS,
  isMemberStatus,
  MEMBER_STATUSES,
  setStatus,
  undelete,
  type Member,
} from '@/modules/members/domain/member';

function fixture(overrides: Partial<Member> = {}): Member {
  const now = new Date('2026-04-15T00:00:00Z');
  return {
    tenantId: 't' as Member['tenantId'],
    memberId: 'm' as Member['memberId'],
    companyName: 'Co',
    legalEntityType: null,
    country: 'TH' as Member['country'],
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'p' as Member['planId'],
    planYear: 2026,
    registrationDate: now,
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    status: 'active',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const NOW = new Date('2026-04-15T12:00:00Z');

describe('Member state machine — setStatus', () => {
  it('active → inactive', () => {
    const r = setStatus(fixture({ status: 'active' }), 'inactive', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('inactive');
  });

  it('inactive → active', () => {
    const r = setStatus(fixture({ status: 'inactive' }), 'active', NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects same-target transition', () => {
    const r = setStatus(fixture({ status: 'active' }), 'active', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('state.already_in_target');
  });

  it('rejects from archived (must go through undelete)', () => {
    const r = setStatus(
      fixture({ status: 'archived', archivedAt: NOW }),
      'active',
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('state.undelete_only_from_archived');
  });
});

describe('Member state machine — archive', () => {
  it('active → archived sets archivedAt', () => {
    const r = archive(fixture({ status: 'active' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('archived');
      expect(r.value.archivedAt).toEqual(NOW);
    }
  });

  it('inactive → archived allowed', () => {
    const r = archive(fixture({ status: 'inactive' }), NOW);
    expect(r.ok).toBe(true);
  });

  it('archived → archived rejected', () => {
    const r = archive(
      fixture({ status: 'archived', archivedAt: NOW }),
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('state.cannot_archive_already_archived');
  });
});

describe('Member state machine — undelete (90-day window)', () => {
  it('archived within window → active', () => {
    const archivedAt = new Date('2026-04-01T00:00:00Z');
    const now = new Date('2026-04-15T00:00:00Z'); // 14 days later
    const r = undelete(fixture({ status: 'archived', archivedAt }), now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('active');
      expect(r.value.archivedAt).toBe(null);
    }
  });

  it('archived at exactly 90 days still OK', () => {
    const archivedAt = new Date('2026-01-15T00:00:00Z');
    const now = new Date('2026-04-15T00:00:00Z'); // exactly 90 days
    const r = undelete(fixture({ status: 'archived', archivedAt }), now);
    expect(r.ok).toBe(true);
  });

  it('archived >90 days rejected', () => {
    const archivedAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-04-15T00:00:00Z'); // 104 days
    const r = undelete(fixture({ status: 'archived', archivedAt }), now);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'state.undelete_window_expired') {
      expect(r.error.daysSinceArchive).toBeGreaterThan(
        ARCHIVE_UNDELETE_WINDOW_DAYS,
      );
    } else {
      expect.fail('expected state.undelete_window_expired');
    }
  });

  it('rejects undelete from non-archived state', () => {
    const r = undelete(fixture({ status: 'active' }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('state.undelete_only_from_archived');
  });

  it('rejects undelete when archivedAt is null even if status archived (defensive)', () => {
    const r = undelete(fixture({ status: 'archived', archivedAt: null }), NOW);
    expect(r.ok).toBe(false);
  });
});

describe('isMemberStatus type-guard', () => {
  it('accepts valid statuses', () => {
    expect(isMemberStatus('active')).toBe(true);
    expect(isMemberStatus('inactive')).toBe(true);
    expect(isMemberStatus('archived')).toBe(true);
  });
  it('rejects others', () => {
    expect(isMemberStatus('deleted')).toBe(false);
    expect(isMemberStatus(null)).toBe(false);
  });
});

describe('MEMBER_STATUSES', () => {
  it('contains exactly active, inactive, archived', () => {
    expect([...MEMBER_STATUSES].sort()).toEqual(['active', 'archived', 'inactive']);
  });
});

describe('Brand constructors', () => {
  it('asTenantId brands a raw string', () => {
    expect(asTenantId('swecham')).toBe('swecham');
  });

  it('asPlanId brands a raw string', () => {
    expect(asPlanId('premium-2026')).toBe('premium-2026');
  });

  it('asMemberId brands a raw string', () => {
    expect(asMemberId('m-001')).toBe('m-001');
  });
});

describe('tryTenantId', () => {
  it('returns ok for a non-empty string', () => {
    const r = tryTenantId('swecham');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('swecham');
  });

  it('returns err for empty / whitespace-only string', () => {
    expect(tryTenantId('').ok).toBe(false);
    expect(tryTenantId('   ').ok).toBe(false);
  });

  it('returns err for non-string values', () => {
    expect(tryTenantId(null).ok).toBe(false);
    expect(tryTenantId(42).ok).toBe(false);
  });
});

describe('tryPlanId', () => {
  it('returns ok for a non-empty string', () => {
    const r = tryPlanId('premium-2026');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('premium-2026');
  });

  it('returns err for empty / whitespace string', () => {
    expect(tryPlanId('').ok).toBe(false);
    expect(tryPlanId('  ').ok).toBe(false);
  });

  it('returns err for non-string values', () => {
    expect(tryPlanId(null).ok).toBe(false);
    expect(tryPlanId(undefined).ok).toBe(false);
  });
});

describe('tryMemberId', () => {
  it('returns ok for a valid UUID', () => {
    const r = tryMemberId('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('normalises to lowercase', () => {
    const r = tryMemberId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns err for a non-UUID string', () => {
    const r = tryMemberId('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_member_id');
  });

  it('returns err for null / number / undefined', () => {
    expect(tryMemberId(null).ok).toBe(false);
    expect(tryMemberId(42).ok).toBe(false);
    expect(tryMemberId(undefined).ok).toBe(false);
  });
});

