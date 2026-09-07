/**
 * Review 2026-09-07 round 2 (C1/C2 — six reviewers) — ONE place turns a
 * persisted `broadcasts` row back into a `RecipientSegment`, and a `tier`
 * row with no codes is a typed, PERMANENT refusal at that boundary. The
 * three `buildSegmentFromBroadcast` copies used to manufacture
 * `{ kind: 'tier', tierCodes: [] }` from a malformed `segment_params` with
 * `?? []`, so on the primary_only leg the tier predicate silently dropped
 * and the E-Blast went to every active member, and on the all_contacts leg
 * the repo's throw was laundered into a transient `resolve.server_error`
 * and retried every tick forever.
 */
import { describe, expect, it } from 'vitest';

import { recipientSegmentFromPersisted } from '@/modules/broadcasts/domain/recipient-segment';

describe('recipientSegmentFromPersisted', () => {
  it('all_members → { kind: all_members } regardless of params', () => {
    expect(
      recipientSegmentFromPersisted({
        segmentType: 'all_members',
        segmentParams: { tierCodes: ['corporate'] },
        customRecipientEmails: null,
      }),
    ).toEqual({ ok: true, value: { kind: 'all_members' } });
  });

  it('tier with codes → { kind: tier, tierCodes }', () => {
    expect(
      recipientSegmentFromPersisted({
        segmentType: 'tier',
        segmentParams: { tierCodes: ['corporate', 'partnership'] },
        customRecipientEmails: null,
      }),
    ).toEqual({
      ok: true,
      value: { kind: 'tier', tierCodes: ['corporate', 'partnership'] },
    });
  });

  it.each([
    ['null params', null],
    ['params without the key', { other: 1 }],
    ['an empty list', { tierCodes: [] }],
    ['a non-array', { tierCodes: 'corporate' }],
    ['a non-string element', { tierCodes: ['corporate', 7] }],
    ['an empty string element', { tierCodes: [''] }],
  ])('tier with %s → malformed_segment (tier_without_codes), never "everyone"', (_label, params) => {
    const result = recipientSegmentFromPersisted({
      segmentType: 'tier',
      segmentParams: params as Record<string, unknown> | null,
      customRecipientEmails: null,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'malformed_segment', segmentType: 'tier', reason: 'tier_without_codes' },
    });
  });

  it('event_attendees_last_90d → { kind: event_attendees_last_90d }', () => {
    expect(
      recipientSegmentFromPersisted({
        segmentType: 'event_attendees_last_90d',
        segmentParams: null,
        customRecipientEmails: null,
      }),
    ).toEqual({ ok: true, value: { kind: 'event_attendees_last_90d' } });
  });

  it('custom → the persisted list; a null list is an empty list', () => {
    expect(
      recipientSegmentFromPersisted({
        segmentType: 'custom',
        segmentParams: null,
        customRecipientEmails: ['a@example.com'],
      }),
    ).toEqual({ ok: true, value: { kind: 'custom', emails: ['a@example.com'] } });
    expect(
      recipientSegmentFromPersisted({
        segmentType: 'custom',
        segmentParams: null,
        customRecipientEmails: null,
      }),
    ).toEqual({ ok: true, value: { kind: 'custom', emails: [] } });
  });
});
