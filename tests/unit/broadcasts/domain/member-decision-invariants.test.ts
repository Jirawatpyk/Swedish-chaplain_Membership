/**
 * F119 T054 (FR-009, FR-010, FR-015a, FR-018, data-model § 10 + § 12) — the
 * version and member-decision invariants.
 *
 * The approval note is "null, or 1–500": a 0-length note would pass a
 * `{ min: 0 }` Domain check and then be refused by the DB CHECK
 * (`reason IS NULL OR char_length(reason) BETWEEN 1 AND 500`) — a 500 at
 * runtime instead of a 422. Lengths count code points, as `char_length` does.
 */
import { describe, expect, it } from 'vitest';
import {
  isVersionEditable,
  type BroadcastVersion,
} from '@/modules/broadcasts/domain/approval/broadcast-version';
import {
  MEMBER_DECISION_KINDS,
  reasonBounds,
  requiresReason,
  scheduleDiffers,
  validateDecisionReason,
} from '@/modules/broadcasts/domain/approval/member-decision';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

const EMOJI = '\u{1F600}'; // one code point, two UTF-16 units

describe('approval note — null or 1–500', () => {
  it('a 501-character approval note is refused while a 500-character one is accepted', () => {
    expect(validateDecisionReason('approved', 'a'.repeat(500)).ok).toBe(true);
    const refused = validateDecisionReason('approved', 'a'.repeat(501));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_too_long', max: 500 });
  });

  it('an empty-string approval note is refused, a null one is accepted', () => {
    const refused = validateDecisionReason('approved', '');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_empty' });
    expect(validateDecisionReason('approved', null)).toEqual({ ok: true, value: null });
  });

  it('a whitespace-only approval note is refused as empty', () => {
    const refused = validateDecisionReason('approved', '   ');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_empty' });
  });

  it('counts code points like char_length: 500 emoji pass, 501 do not', () => {
    expect(validateDecisionReason('approved', EMOJI.repeat(500)).ok).toBe(true);
    expect(validateDecisionReason('approved', EMOJI.repeat(501)).ok).toBe(false);
  });

  it('a 1-character note is the lower bound and is returned unchanged', () => {
    expect(validateDecisionReason('approved', 'x')).toEqual({ ok: true, value: 'x' });
  });
});

describe('changes requested / approval withdrawn — mandatory 1–2,000', () => {
  it.each(['changes_requested', 'approval_withdrawn'] as const)(
    '%s: null is refused as required',
    (kind) => {
      const refused = validateDecisionReason(kind, null);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_required' });
    },
  );

  it.each(['changes_requested', 'approval_withdrawn'] as const)(
    '%s: empty and whitespace-only are refused as empty',
    (kind) => {
      for (const blank of ['', ' \n\t ']) {
        const refused = validateDecisionReason(kind, blank);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_empty' });
      }
    },
  );

  it.each(['changes_requested', 'approval_withdrawn'] as const)(
    '%s: 2,000 is accepted and 2,001 refused',
    (kind) => {
      expect(validateDecisionReason(kind, 'b'.repeat(2000))).toEqual({
        ok: true,
        value: 'b'.repeat(2000),
      });
      const refused = validateDecisionReason(kind, 'b'.repeat(2001));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toEqual({ code: 'reason_too_long', max: 2000 });
    },
  );
});

describe('requiresReason / reasonBounds', () => {
  it('declares exactly the three decision kinds of the DB CHECK', () => {
    expect(MEMBER_DECISION_KINDS).toEqual([
      'approved',
      'changes_requested',
      'approval_withdrawn',
    ]);
  });

  it('requires a reason for every kind except `approved`', () => {
    expect(requiresReason('approved')).toBe(false);
    expect(requiresReason('changes_requested')).toBe(true);
    expect(requiresReason('approval_withdrawn')).toBe(true);
  });

  it('bounds the approval note to null-or-1–500 — never 0–500', () => {
    expect(reasonBounds('approved')).toEqual({ min: 1, max: 500, nullable: true });
  });

  it('bounds the mandatory reasons to 1–2,000, not nullable', () => {
    expect(reasonBounds('changes_requested')).toEqual({ min: 1, max: 2000, nullable: false });
    expect(reasonBounds('approval_withdrawn')).toEqual({ min: 1, max: 2000, nullable: false });
  });
});

describe('isVersionEditable', () => {
  const version: BroadcastVersion = {
    id: 'v-1',
    tenantId: 'test',
    broadcastId: asBroadcastId('11111111-1111-4111-8111-111111111111'),
    versionNo: 1,
    subject: 's',
    bodyHtml: '<p>b</p>',
    bodySource: 'b',
    noteToMember: null,
    authoredByUserId: 'u-1',
    authoredByRole: 'admin_proxy',
    sentToMemberAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('an unsent version is editable', () => {
    expect(isVersionEditable(version)).toBe(true);
  });

  it('a version sent to the member is frozen', () => {
    expect(isVersionEditable({ ...version, sentToMemberAt: new Date('2026-09-02T00:00:00Z') })).toBe(
      false,
    );
  });
});

describe('scheduleDiffers (FR-018)', () => {
  const confirmed = new Date('2026-10-01T03:00:00Z');

  it('the same instant is not a difference, even as a different Date object', () => {
    expect(scheduleDiffers(new Date('2026-10-01T03:00:00.000Z'), confirmed)).toBe(false);
  });

  it('a different instant differs', () => {
    expect(scheduleDiffers(new Date('2026-10-01T04:00:00Z'), confirmed)).toBe(true);
  });

  it('no proposal at all differs — the confirmed time is not the proposal', () => {
    expect(scheduleDiffers(null, confirmed)).toBe(true);
  });
});
