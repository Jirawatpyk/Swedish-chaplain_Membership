import { describe, expect, it } from 'vitest';
import { assertPrimaryContactInvariant } from '@/modules/members/domain/policies/primary-contact-invariant';
import { checkTurnoverBand } from '@/modules/members/domain/policies/turnover-policy';
import {
  checkAgeEligibility,
  THAI_ALUMNI_MAX_AGE,
} from '@/modules/members/domain/policies/age-eligibility-policy';
import {
  checkStartupDuration,
  STARTUP_MAX_AGE_YEARS,
} from '@/modules/members/domain/policies/startup-duration-policy';
import {
  archiveWindowStatus,
  ARCHIVE_UNDELETE_WINDOW_DAYS,
} from '@/modules/members/domain/policies/archive-window-policy';
import type { Contact } from '@/modules/members/domain/contact';
import {
  isPortalSelfUpdateContactField,
  isPortalSelfUpdateMemberField,
} from '@/modules/members/domain/portal-self-update-fields';

// M5: Contact is a discriminated union (isPrimary ⟹ not removed). This
// fixture deliberately supports constructing the now-unrepresentable
// "primary + removed" combination via an `as Contact` cast, because the
// policy under test (assertPrimaryContactInvariant) is a runtime defensive
// guard against exactly such type-violating input (e.g. corrupt rows).
function contactFixture(
  overrides: Partial<Omit<Contact, 'isPrimary' | 'removedAt'>> & {
    isPrimary?: boolean;
    removedAt?: Date | null;
  } = {},
): Contact {
  const now = new Date('2026-04-15T00:00:00Z');
  const { isPrimary = false, removedAt = null, ...rest } = overrides;
  return {
    tenantId: 't' as Contact['tenantId'],
    contactId: 'c' as Contact['contactId'],
    memberId: 'm' as Contact['memberId'],
    firstName: 'A',
    lastName: 'B',
    email: 'a@b.co' as Contact['email'],
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: null,
    createdAt: now,
    updatedAt: now,
    isPrimary,
    removedAt,
    ...rest,
  } as Contact;
}

// --- primary-contact-invariant -------------------------------------------

describe('assertPrimaryContactInvariant', () => {
  it('ok — exactly one primary, active', () => {
    const r = assertPrimaryContactInvariant(
      [contactFixture({ isPrimary: true })],
      'active',
    );
    expect(r.ok).toBe(true);
  });

  it('zero primaries on active member', () => {
    const r = assertPrimaryContactInvariant(
      [contactFixture({ isPrimary: false })],
      'active',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('primary.zero_primaries');
  });

  it('multiple primaries on active member', () => {
    const r = assertPrimaryContactInvariant(
      [
        contactFixture({ contactId: 'a' as Contact['contactId'], isPrimary: true }),
        contactFixture({ contactId: 'b' as Contact['contactId'], isPrimary: true }),
      ],
      'active',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('primary.multiple_primaries');
  });

  it('removed contact cannot be primary', () => {
    const r = assertPrimaryContactInvariant(
      [
        contactFixture({
          isPrimary: true,
          removedAt: new Date('2026-03-01T00:00:00Z'),
        }),
      ],
      'active',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('primary.removed_and_primary');
  });

  it('invariant suspended when member archived', () => {
    const r = assertPrimaryContactInvariant(
      [contactFixture({ isPrimary: false })],
      'archived',
    );
    expect(r.ok).toBe(true);
  });

  it('inactive member still requires one primary', () => {
    const r = assertPrimaryContactInvariant(
      [contactFixture({ isPrimary: true })],
      'inactive',
    );
    expect(r.ok).toBe(true);
  });
});

// --- turnover-policy ------------------------------------------------------

describe('checkTurnoverBand', () => {
  it('null turnover skips check', () => {
    const r = checkTurnoverBand(null, { minThb: 1_000_000, maxThb: 10_000_000 });
    expect(r.ok).toBe(true);
  });

  it('within band', () => {
    const r = checkTurnoverBand(5_000_000, {
      minThb: 1_000_000,
      maxThb: 10_000_000,
    });
    expect(r.ok).toBe(true);
  });

  it('below min', () => {
    const r = checkTurnoverBand(500_000, { minThb: 1_000_000, maxThb: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('turnover.outside_band');
  });

  it('above max', () => {
    const r = checkTurnoverBand(20_000_000, { minThb: null, maxThb: 10_000_000 });
    expect(r.ok).toBe(false);
  });

  it('open band (both null)', () => {
    const r = checkTurnoverBand(5_000_000, { minThb: null, maxThb: null });
    expect(r.ok).toBe(true);
  });
});

// --- age-eligibility-policy ----------------------------------------------

describe('checkAgeEligibility (Thai Alumni)', () => {
  const planStart = new Date('2026-01-01T00:00:00Z');

  it('age 35 at plan start OK (inclusive)', () => {
    const dob = new Date('1991-01-01T00:00:00Z'); // exactly 35
    const r = checkAgeEligibility(dob, planStart);
    expect(r.ok).toBe(true);
  });

  it('age 36 rejected', () => {
    const dob = new Date('1989-06-01T00:00:00Z');
    const r = checkAgeEligibility(dob, planStart);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('age.over_max');
      expect(r.error.maxAge).toBe(THAI_ALUMNI_MAX_AGE);
    }
  });

  it('handles end-of-year DOB (month/day delta negative)', () => {
    const dob = new Date('1990-12-31T00:00:00Z'); // 35y on 2025-12-31; planStart 2026-01-01 → 35
    const r = checkAgeEligibility(dob, planStart);
    expect(r.ok).toBe(true);
  });

  it('explicit maxAge override', () => {
    const dob = new Date('1990-01-01T00:00:00Z'); // 36
    const r = checkAgeEligibility(dob, planStart, 40);
    expect(r.ok).toBe(true);
  });
});

// --- startup-duration-policy ---------------------------------------------

describe('checkStartupDuration', () => {
  const reg = new Date('2026-06-01T00:00:00Z');

  it('founded 2026 OK', () => {
    const r = checkStartupDuration(2026, reg);
    expect(r.ok).toBe(true);
  });

  it('founded 2024 (2 years old) OK', () => {
    const r = checkStartupDuration(2024, reg);
    expect(r.ok).toBe(true);
  });

  it('founded 2023 (3 years old) rejected', () => {
    const r = checkStartupDuration(2023, reg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.maxAllowedYears).toBe(STARTUP_MAX_AGE_YEARS);
  });
});

// --- archive-window-policy -----------------------------------------------

describe('archiveWindowStatus', () => {
  const now = new Date('2026-04-15T00:00:00Z');

  it('not_archived when archivedAt null', () => {
    expect(archiveWindowStatus(null, now)).toEqual({ state: 'not_archived' });
  });

  it('within_window reports daysRemaining', () => {
    const archivedAt = new Date('2026-04-01T00:00:00Z'); // 14 days ago
    const s = archiveWindowStatus(archivedAt, now);
    expect(s.state).toBe('within_window');
    if (s.state === 'within_window')
      expect(s.daysRemaining).toBe(ARCHIVE_UNDELETE_WINDOW_DAYS - 14);
  });

  it('window_expired past 90 days', () => {
    const archivedAt = new Date('2025-12-01T00:00:00Z'); // >90 days
    const s = archiveWindowStatus(archivedAt, now);
    expect(s.state).toBe('window_expired');
  });
});

// --- portal-self-update-fields -------------------------------------------

describe('portal-self-update-fields allow-lists', () => {
  it('allow-lists contact fields', () => {
    expect(isPortalSelfUpdateContactField('firstName')).toBe(true);
    expect(isPortalSelfUpdateContactField('email')).toBe(false);
    expect(isPortalSelfUpdateContactField('isPrimary')).toBe(false);
  });

  it('allow-lists member fields', () => {
    expect(isPortalSelfUpdateMemberField('website')).toBe(true);
    expect(isPortalSelfUpdateMemberField('description')).toBe(true);
    expect(isPortalSelfUpdateMemberField('planId')).toBe(false);
    expect(isPortalSelfUpdateMemberField('turnoverThb')).toBe(false);
  });
});
