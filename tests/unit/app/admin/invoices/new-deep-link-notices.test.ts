/**
 * #89 (UX L6 on #777) — /admin/invoices/new says when a deep link cannot be
 * used, instead of opening with an empty picker and no word why.
 */
import { describe, expect, it } from 'vitest';
import { deepLinkNotices } from '@/app/(staff)/admin/invoices/new/_lib/deep-link-notices';

const M = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b';
const E = '9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const R = '11111111-2222-4333-8444-555555555555';
const member = { memberId: M };
const event = { eventId: E };

describe('deepLinkNotices', () => {
  it('says nothing without a deep link', () => {
    expect(deepLinkNotices({ members: [member], events: [event] })).toEqual([]);
  });

  it('says nothing when the linked member and event are offered', () => {
    expect(
      deepLinkNotices({
        initialMemberId: M,
        members: [member],
        initialRegistrationId: R,
        initialEventId: E,
        events: [event],
      }),
    ).toEqual([]);
  });

  it('names a linked member that is not offered (archived, gone, or the read failed)', () => {
    expect(deepLinkNotices({ initialMemberId: M, members: [], events: [] })).toEqual(['memberLinkUnusable']);
  });

  it('names a linked registration whose event did not resolve or is not offered', () => {
    expect(deepLinkNotices({ initialRegistrationId: R, members: [], events: [event] })).toEqual([
      'registrationLinkUnusable',
    ]);
    expect(
      deepLinkNotices({ initialRegistrationId: R, initialEventId: E, members: [], events: [] }),
    ).toEqual(['registrationLinkUnusable']);
  });
});
