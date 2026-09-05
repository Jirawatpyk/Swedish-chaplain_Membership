/**
 * 108 PR-D T103 (FR-031b) — ONE shared vocabulary for "why does this contact
 * not receive a broadcast", consumed by the member page badge, the Marketing
 * audience page and (PR-C) the compose-time count feedback. Ten codes, pinned
 * so a surface cannot invent an eleventh phrasing.
 */
import { describe, expect, it } from 'vitest';
import {
  MARKETING_REASONS,
  marketingNonReceiptReasons,
} from '@/modules/members/domain/marketing-reason';

describe('MARKETING_REASONS — the FR-031b vocabulary', () => {
  it('pins exactly the ten codes', () => {
    expect([...MARKETING_REASONS]).toEqual([
      'member_inactive',
      'member_archived',
      'member_erased',
      'member_halted',
      'contact_removed',
      'off_by_staff',
      'off_by_contact',
      'unsubscribed',
      'sender_own_contact',
      'member_no_eligible_contact',
    ]);
  });
});

describe('marketingNonReceiptReasons — member-level first, then contact-level', () => {
  const base = {
    memberStatus: 'active' as const,
    memberErased: false,
    memberHalted: false,
    contactRemoved: false,
    state: 'on' as const,
  };

  it('an eligible member with a receiving contact → no reasons', () => {
    expect(marketingNonReceiptReasons(base)).toEqual([]);
  });

  it('inactive member', () => {
    expect(marketingNonReceiptReasons({ ...base, memberStatus: 'inactive' })).toEqual([
      'member_inactive',
    ]);
  });

  it('archived member', () => {
    expect(marketingNonReceiptReasons({ ...base, memberStatus: 'archived' })).toEqual([
      'member_archived',
    ]);
  });

  it('erased member (reported alongside its archived status — both are true facts)', () => {
    expect(
      marketingNonReceiptReasons({ ...base, memberStatus: 'archived', memberErased: true }),
    ).toEqual(['member_archived', 'member_erased']);
  });

  it('halted member', () => {
    expect(marketingNonReceiptReasons({ ...base, memberHalted: true })).toEqual(['member_halted']);
  });

  it('removed contact', () => {
    expect(marketingNonReceiptReasons({ ...base, contactRemoved: true })).toEqual([
      'contact_removed',
    ]);
  });

  it.each([
    ['off_by_staff', 'off_by_staff'],
    ['off_by_contact', 'off_by_contact'],
    ['unsubscribed', 'unsubscribed'],
  ] as const)('state %s → reason %s', (state, reason) => {
    expect(marketingNonReceiptReasons({ ...base, state })).toEqual([reason]);
  });

  it('"unavailable" state contributes no state reason (nothing is known)', () => {
    expect(marketingNonReceiptReasons({ ...base, state: 'unavailable' })).toEqual([]);
  });

  it('stacks member-level and contact-level reasons in vocabulary order', () => {
    expect(
      marketingNonReceiptReasons({
        memberStatus: 'inactive',
        memberErased: false,
        memberHalted: true,
        contactRemoved: false,
        state: 'off_by_contact',
      }),
    ).toEqual(['member_inactive', 'member_halted', 'off_by_contact']);
  });
});
