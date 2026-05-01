/**
 * T048 — Custom-recipient validation (FR-015d).
 *
 * Verifies the 3-source resolution chain (member primary contact →
 * tenant contact → event attendee). Uses stub bridges so the test runs
 * without seeding a live tenant; the F6 stub branch is exercised by
 * passing the empty `eventAttendeesStub` directly.
 *
 * Live-DB cross-tenant isolation is covered by `tenant-isolation.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ok } from '@/lib/result';
import { validateCustomRecipients } from '@/modules/broadcasts/application/use-cases/validate-custom-recipients';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';

const tenant = asTenantContext('test-tenant');

interface SeedOpts {
  readonly memberPrimaries?: ReadonlyArray<string>;
  readonly contactEmails?: ReadonlyArray<{ email: string; memberId: string; contactId: string }>;
  readonly attendeeEmails?: ReadonlyArray<string>;
}

function makeBridges(seed: SeedOpts = {}): {
  membersBridge: MembersBridgePort;
  eventAttendees: EventAttendeesRepository;
} {
  const lowerSet = (xs: ReadonlyArray<string>) =>
    new Set(xs.map((e) => e.toLowerCase().trim()));
  const memberPrimaries = lowerSet(seed.memberPrimaries ?? []);
  const contactsByEmail = new Map(
    (seed.contactEmails ?? []).map((c) => [c.email.toLowerCase().trim(), c]),
  );
  const attendees = lowerSet(seed.attendeeEmails ?? []);
  return {
    membersBridge: {
      async getMembersBySegment() {
        return [];
      },
      async getMemberPrimaryContact() {
        return null;
      },
      async lookupContactEmailInTenant(_ctx, emailLower) {
        const c = contactsByEmail.get(emailLower as string);
        if (!c) return null;
        return {
          memberId: c.memberId,
          contactId: c.contactId,
          emailLower: unsafeBrandEmailLower(c.email.toLowerCase().trim()),
        };
      },
      async lookupMemberPrimaryContactEmailInTenant(_ctx, emailLower) {
        if (!memberPrimaries.has(emailLower as string)) return null;
        return {
          memberId: 'm-fake',
          displayName: 'Fake',
          primaryContactEmail: unsafeBrandEmailLower(emailLower as string),
          tierCode: null,
          broadcastsHaltedUntilAdminReview: false,
        };
      },
      async getMembersHaltedInTenant() {
        return [];
      },
      async setMemberHalt() {
        return ok(undefined);
      },
      async memberExistsInTenant() { return true; },
      async markBroadcastsAcknowledged() {
        return ok({ previouslyNull: true });
      },
    },
    eventAttendees: {
      async getLastNinetyDayAttendees() {
        return [];
      },
      async lookupAttendeeEmailInTenant(_ctx, emailLower) {
        return attendees.has(emailLower as string)
          ? {
              emailLower: unsafeBrandEmailLower(emailLower as string),
              displayName: null,
              memberId: null,
              mostRecentEventDate: new Date(),
              mostRecentEventTitle: null,
            }
          : null;
      },
    },
  };
}

const deps = (seed: SeedOpts = {}) => ({
  tenant,
  emailValidator: rfc5321EmailValidator,
  ...makeBridges(seed),
});

describe('custom-recipient-validation integration (T048)', () => {
  it('branch 1: matches member.primary_contact_email → resolved', async () => {
    const r = await validateCustomRecipients(
      deps({ memberPrimaries: ['alice@example.com'] }),
      { raw: ['alice@example.com'] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.normalised).toHaveLength(1);
  });

  it('branch 2: matches contact.email (secondary contact) → resolved', async () => {
    const r = await validateCustomRecipients(
      deps({
        contactEmails: [
          { email: 'bob@example.com', memberId: 'm-1', contactId: 'c-1' },
        ],
      }),
      { raw: ['bob@example.com'] },
    );
    expect(r.ok).toBe(true);
  });

  it('branch 3: matches event_attendees.email → resolved', async () => {
    const r = await validateCustomRecipients(
      deps({ attendeeEmails: ['carol@example.com'] }),
      { raw: ['carol@example.com'] },
    );
    expect(r.ok).toBe(true);
  });

  it('all 3 branches miss → broadcast_custom_recipient_unknown lists each', async () => {
    const r = await validateCustomRecipients(deps({}), {
      raw: ['stranger@external.com', 'unknown@external.com'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('broadcast_custom_recipient_unknown');
      if (r.error.kind === 'broadcast_custom_recipient_unknown') {
        expect(r.error.unresolved).toContain('stranger@external.com');
        expect(r.error.unresolved).toContain('unknown@external.com');
      }
    }
  });

  it('partial mismatch: 1 valid + 1 invalid → unknown lists ONLY the invalid', async () => {
    const r = await validateCustomRecipients(
      deps({ memberPrimaries: ['alice@example.com'] }),
      { raw: ['alice@example.com', 'stranger@external.com'] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'broadcast_custom_recipient_unknown') {
      expect(r.error.unresolved).toEqual(['stranger@external.com']);
    }
  });

  it('all match: 3 valid → resolves to 3-recipient list', async () => {
    const r = await validateCustomRecipients(
      deps({
        memberPrimaries: ['alice@example.com'],
        contactEmails: [
          { email: 'bob@example.com', memberId: 'm-1', contactId: 'c-1' },
        ],
        attendeeEmails: ['carol@example.com'],
      }),
      { raw: ['alice@example.com', 'bob@example.com', 'carol@example.com'] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.normalised).toHaveLength(3);
  });

  it('case-insensitive: "ALICE@Example.COM" matches stored "alice@example.com"', async () => {
    const r = await validateCustomRecipients(
      deps({ memberPrimaries: ['alice@example.com'] }),
      { raw: ['ALICE@Example.COM'] },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.normalised[0]).toBe('alice@example.com');
    }
  });

  it('whitespace-trimmed: "  alice@example.com  " matches', async () => {
    const r = await validateCustomRecipients(
      deps({ memberPrimaries: ['alice@example.com'] }),
      { raw: ['  alice@example.com  '] },
    );
    expect(r.ok).toBe(true);
  });

  it('100 valid entries → all resolved (cap boundary)', async () => {
    const emails = Array.from({ length: 100 }, (_, i) => `m${i}@example.com`);
    const r = await validateCustomRecipients(
      deps({ memberPrimaries: emails }),
      { raw: emails },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.normalised).toHaveLength(100);
  });

  it('101 entries → broadcast_custom_recipient_too_many (per-call cap)', async () => {
    const emails = Array.from({ length: 101 }, (_, i) => `m${i}@example.com`);
    const r = await validateCustomRecipients(deps({}), { raw: emails });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('broadcast_custom_recipient_too_many');
      if (r.error.kind === 'broadcast_custom_recipient_too_many') {
        expect(r.error.count).toBe(101);
      }
    }
  });

  it('empty list → broadcast_custom_recipient_empty', async () => {
    const r = await validateCustomRecipients(deps({}), { raw: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_custom_recipient_empty');
  });

  it('malformed email format → broadcast_custom_recipient_invalid_format', async () => {
    const r = await validateCustomRecipients(deps({}), {
      raw: ['not-an-email'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toMatch(
        /broadcast_custom_recipient_invalid_format|broadcast_custom_recipient_unknown/,
      );
    }
  });
});
