/**
 * R3.2.2 / CG-2 — Unit tests for `asMatchResolutionView` throw paths.
 *
 * Phase H3.2 added `asMatchResolutionView()` which throws
 * `MatchResolutionInvariantError` if the underlying flat
 * `MatchResolution` violates the per-variant invariant (e.g.
 * `type=member_contact` but `matchedContactId=null`). The Drizzle
 * registrations-repo mapper calls this at the row→aggregate boundary.
 *
 * Without these tests, a regression that silently returned the loose
 * shape (e.g. someone changing `throw new MatchResolutionInvariantError(m)`
 * → `return m as MatchResolutionView`) would not be caught. The
 * read-time invariant is the safety net behind the migration 0136
 * write-time CHECK; both must be tested.
 *
 * Coverage matrix:
 *   - 3 happy-path variants (member_contact / member_domain or _fuzzy /
 *     non_member or unmatched).
 *   - 8 invariant-violation throw cases (every variant × every nullity
 *     mistake).
 *   - MatchResolutionInvariantError shape (name, raw, message).
 */
import { describe, expect, it } from 'vitest';
import {
  asMatchResolutionView,
  MatchResolutionInvariantError,
  type MatchResolution,
} from '@/modules/events/domain/event-registration';
import { asMemberId, asContactId } from '@/modules/members';

const MEMBER_ID = asMemberId('11111111-2222-4333-8444-555555555555');
const CONTACT_ID = asContactId('aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee');

describe('R3.2.2 — asMatchResolutionView happy paths', () => {
  it('member_contact with both IDs set → returns narrowed view', () => {
    const input: MatchResolution = {
      type: 'member_contact',
      matchedMemberId: MEMBER_ID,
      matchedContactId: CONTACT_ID,
    };
    const view = asMatchResolutionView(input);
    expect(view.type).toBe('member_contact');
    expect(view.matchedMemberId).toBe(MEMBER_ID);
    expect(view.matchedContactId).toBe(CONTACT_ID);
  });

  it('member_domain with matchedMemberId only → returns narrowed view', () => {
    const input: MatchResolution = {
      type: 'member_domain',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };
    const view = asMatchResolutionView(input);
    expect(view.type).toBe('member_domain');
    expect(view.matchedMemberId).toBe(MEMBER_ID);
    expect(view.matchedContactId).toBeNull();
  });

  it('member_fuzzy with matchedMemberId only → returns narrowed view', () => {
    const input: MatchResolution = {
      type: 'member_fuzzy',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };
    const view = asMatchResolutionView(input);
    expect(view.type).toBe('member_fuzzy');
    expect(view.matchedMemberId).toBe(MEMBER_ID);
    expect(view.matchedContactId).toBeNull();
  });

  it('non_member with both nulls → returns narrowed view', () => {
    const input: MatchResolution = {
      type: 'non_member',
      matchedMemberId: null,
      matchedContactId: null,
    };
    const view = asMatchResolutionView(input);
    expect(view.type).toBe('non_member');
    expect(view.matchedMemberId).toBeNull();
    expect(view.matchedContactId).toBeNull();
  });

  it('unmatched with both nulls → returns narrowed view', () => {
    const input: MatchResolution = {
      type: 'unmatched',
      matchedMemberId: null,
      matchedContactId: null,
    };
    const view = asMatchResolutionView(input);
    expect(view.type).toBe('unmatched');
    expect(view.matchedMemberId).toBeNull();
    expect(view.matchedContactId).toBeNull();
  });
});

describe('R3.2.2 — asMatchResolutionView invariant-violation throws', () => {
  it('member_contact with matchedContactId=null → throws MatchResolutionInvariantError', () => {
    const bad: MatchResolution = {
      type: 'member_contact',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('member_contact with matchedMemberId=null → throws', () => {
    const bad: MatchResolution = {
      type: 'member_contact',
      matchedMemberId: null,
      matchedContactId: CONTACT_ID,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('member_domain with matchedContactId !== null → throws', () => {
    const bad: MatchResolution = {
      type: 'member_domain',
      matchedMemberId: MEMBER_ID,
      matchedContactId: CONTACT_ID,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('member_domain with matchedMemberId=null → throws', () => {
    const bad: MatchResolution = {
      type: 'member_domain',
      matchedMemberId: null,
      matchedContactId: null,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('member_fuzzy with matchedContactId !== null → throws', () => {
    const bad: MatchResolution = {
      type: 'member_fuzzy',
      matchedMemberId: MEMBER_ID,
      matchedContactId: CONTACT_ID,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('member_fuzzy with matchedMemberId=null → throws', () => {
    const bad: MatchResolution = {
      type: 'member_fuzzy',
      matchedMemberId: null,
      matchedContactId: null,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('non_member with matchedMemberId !== null → throws', () => {
    const bad: MatchResolution = {
      type: 'non_member',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });

  it('unmatched with matchedContactId !== null → throws', () => {
    const bad: MatchResolution = {
      type: 'unmatched',
      matchedMemberId: null,
      matchedContactId: CONTACT_ID,
    };
    expect(() => asMatchResolutionView(bad)).toThrow(MatchResolutionInvariantError);
  });
});

describe('R3.2.2 — MatchResolutionInvariantError shape', () => {
  it('error name and raw + message are preserved for forensic-log reading', () => {
    const bad: MatchResolution = {
      type: 'member_contact',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };

    let captured: MatchResolutionInvariantError | null = null;
    try {
      asMatchResolutionView(bad);
    } catch (e) {
      if (e instanceof MatchResolutionInvariantError) {
        captured = e;
      }
    }

    expect(captured).not.toBeNull();
    expect(captured!.name).toBe('MatchResolutionInvariantError');
    expect(captured!.raw).toEqual(bad);
    expect(captured!.message).toContain('type=member_contact');
    expect(captured!.message).toContain('matchedContactId=null');
    expect(captured!.message).toContain('matchedMemberId=set');
  });

  it('extends Error so pino err serializer picks it up', () => {
    const bad: MatchResolution = {
      type: 'non_member',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null,
    };
    try {
      asMatchResolutionView(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(MatchResolutionInvariantError);
    }
  });
});
