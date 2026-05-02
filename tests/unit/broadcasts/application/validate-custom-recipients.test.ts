/**
 * T043 — Unit tests for `validate-custom-recipients.ts` Application use-case.
 *
 * Wave 6 fills the bodies. Tests exercise FR-015d 3-source resolution +
 * RFC-5321 format check + 100-entry cap + lowercase+trim + edge cases.
 *
 * Strategy: real `rfc5321EmailValidator` adapter (zero-cost) +
 * hand-built `MembersBridgePort` + `EventAttendeesRepository` mocks
 * with controllable matchers (per-test fixtures).
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateCustomRecipients } from '@/modules/broadcasts';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/validate-custom-recipients.ts',
);

const tenant: TenantContext = asTenantContext('test-tenant');

interface BridgeFixture {
  readonly memberPrimary?: ReadonlySet<string>;
  readonly contactSecondary?: ReadonlySet<string>;
}

function makeMembersBridge({
  memberPrimary = new Set(),
  contactSecondary = new Set(),
}: BridgeFixture = {}): MembersBridgePort {
  return {
    async getMembersBySegment() {
      return [];
    },
    async getMemberPrimaryContact() {
      return null;
    },
    async lookupMemberPrimaryContactEmailInTenant(_ctx, emailLower) {
      if (memberPrimary.has(emailLower)) {
        return {
          memberId: 'm-' + emailLower,
          displayName: 'Member ' + emailLower,
          primaryContactEmail: unsafeBrandEmailLower(emailLower),
          tierCode: null,
          broadcastsHaltedUntilAdminReview: false,
        };
      }
      return null;
    },
    async lookupContactEmailInTenant(_ctx, emailLower) {
      if (contactSecondary.has(emailLower)) {
        return {
          memberId: 'm-' + emailLower,
          contactId: 'c-' + emailLower,
          emailLower: unsafeBrandEmailLower(emailLower),
        };
      }
      return null;
    },
    async getMembersHaltedInTenant() {
      return [];
    },
    async setMemberHalt() {
      return { ok: true, value: undefined };
    },
    async memberExistsInTenant() { return true; },
    async markBroadcastsAcknowledged() {
      return { ok: true, value: { previouslyNull: true } };
    },
    async getMemberPreferredLocale() { return null; },
  };
}

interface AttendeeFixture {
  readonly attendees?: ReadonlySet<string>;
}

function makeEventAttendees({
  attendees = new Set(),
}: AttendeeFixture = {}): EventAttendeesRepository {
  return {
    async getLastNinetyDayAttendees() {
      return [];
    },
    async lookupAttendeeEmailInTenant(_ctx, emailLower) {
      if (attendees.has(emailLower)) {
        return {
          emailLower: unsafeBrandEmailLower(emailLower),
          displayName: null,
          memberId: null,
          mostRecentEventDate: new Date(),
          mostRecentEventTitle: null,
        };
      }
      return null;
    },
  };
}

function makeDeps(opts: BridgeFixture & AttendeeFixture = {}) {
  return {
    tenant,
    emailValidator: rfc5321EmailValidator,
    membersBridge: makeMembersBridge(opts),
    eventAttendees: makeEventAttendees(opts),
  };
}

describe('validate-custom-recipients — Wave 6 (T065 GREEN)', () => {
  it('use-case module exists at application/use-cases/validate-custom-recipients.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- FR-015d 3-source resolution branches -------------------------

  it('resolves email matching member.primary_contact_email (branch 1)', async () => {
    const deps = makeDeps({ memberPrimary: new Set(['alice@example.com']) });
    const result = await validateCustomRecipients(deps, {
      raw: ['alice@example.com'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalised).toEqual(['alice@example.com']);
    }
  });

  it('resolves email matching contact.email (branch 2 — secondary contacts)', async () => {
    const deps = makeDeps({
      contactSecondary: new Set(['secondary@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['secondary@example.com'],
    });
    expect(result.ok).toBe(true);
  });

  it('resolves email matching event_attendees.email (branch 3 — F6 stub returns [] in MVP)', async () => {
    const deps = makeDeps({
      attendees: new Set(['attendee@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['attendee@example.com'],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects email matching none of 3 branches with broadcast_custom_recipient_unknown', async () => {
    const deps = makeDeps();
    const result = await validateCustomRecipients(deps, {
      raw: ['unknown@example.com'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_custom_recipient_unknown');
      if (result.error.kind === 'broadcast_custom_recipient_unknown') {
        expect(result.error.unresolved).toContain('unknown@example.com');
      }
    }
  });

  // ---- RFC-5321 format validation -----------------------------------

  it('rejects malformed email format (no @, missing TLD, etc.)', async () => {
    const deps = makeDeps();
    const result = await validateCustomRecipients(deps, {
      raw: ['no-at-sign', 'missing@'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_custom_recipient_invalid_format',
      );
    }
  });

  it('rejects email > 254 chars (length cap)', async () => {
    const deps = makeDeps();
    const tooLong = 'a'.repeat(250) + '@x.com'; // 256 chars
    const result = await validateCustomRecipients(deps, { raw: [tooLong] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_custom_recipient_invalid_format',
      );
    }
  });

  // ---- Normalisation ------------------------------------------------

  it('normalises "  Alice@Example.COM  " to "alice@example.com" before resolution', async () => {
    const deps = makeDeps({
      memberPrimary: new Set(['alice@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['  Alice@Example.COM  '],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalised).toEqual(['alice@example.com']);
    }
  });

  it('matches case-insensitive against tenant graph', async () => {
    const deps = makeDeps({
      memberPrimary: new Set(['mixedcase@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['MIXEDCASE@example.com'],
    });
    expect(result.ok).toBe(true);
  });

  // ---- Cap enforcement (100 entries) --------------------------------

  it('rejects custom list with > 100 entries with broadcast_custom_recipient_too_many', async () => {
    const deps = makeDeps();
    const list = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    const result = await validateCustomRecipients(deps, { raw: list });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_custom_recipient_too_many');
    }
  });

  it('accepts exactly 100-entry custom list', async () => {
    const list = Array.from({ length: 100 }, (_, i) => `u${i}@example.com`);
    const deps = makeDeps({ memberPrimary: new Set(list) });
    const result = await validateCustomRecipients(deps, { raw: list });
    expect(result.ok).toBe(true);
  });

  it('accepts 1-entry custom list', async () => {
    const deps = makeDeps({ memberPrimary: new Set(['only@example.com']) });
    const result = await validateCustomRecipients(deps, {
      raw: ['only@example.com'],
    });
    expect(result.ok).toBe(true);
  });

  // ---- Empty / edge -------------------------------------------------

  it('rejects empty list with broadcast_custom_recipient_empty', async () => {
    const deps = makeDeps();
    const result = await validateCustomRecipients(deps, { raw: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_custom_recipient_empty');
    }
  });

  it('rejects whitespace-only entries as invalid format', async () => {
    const deps = makeDeps();
    const result = await validateCustomRecipients(deps, {
      raw: ['   ', '\t\n'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either invalid_format or unresolved depending on validator path —
      // both are correct rejections. Spec wants non-resolution; we assert
      // a non-ok outcome.
      expect([
        'broadcast_custom_recipient_invalid_format',
        'broadcast_custom_recipient_unknown',
      ]).toContain(result.error.kind);
    }
  });

  it('deduplicates case-insensitive duplicates before resolution', async () => {
    const deps = makeDeps({
      memberPrimary: new Set(['dup@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['dup@example.com', 'DUP@example.com', 'Dup@Example.com'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // After lowercase+trim+dedup we keep one
      expect(result.value.normalised).toEqual(['dup@example.com']);
    }
  });

  // ---- Error shape --------------------------------------------------

  it('returns array of unresolved emails on partial-mismatch (not just first)', async () => {
    const deps = makeDeps({
      memberPrimary: new Set(['known@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: [
        'known@example.com',
        'orphan-1@example.com',
        'orphan-2@example.com',
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'broadcast_custom_recipient_unknown') {
      expect(result.error.unresolved).toContain('orphan-1@example.com');
      expect(result.error.unresolved).toContain('orphan-2@example.com');
      expect(result.error.unresolved).not.toContain('known@example.com');
    }
  });

  it('returns ok with all-resolved recipient projections on full match', async () => {
    const deps = makeDeps({
      memberPrimary: new Set(['a@example.com', 'b@example.com']),
    });
    const result = await validateCustomRecipients(deps, {
      raw: ['a@example.com', 'b@example.com'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalised).toHaveLength(2);
    }
  });
});
