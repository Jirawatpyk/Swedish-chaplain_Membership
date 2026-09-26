/**
 * F9 US6 (T091) — GDPR audit-subset scoping + redaction unit tests.
 *
 * 100% branch coverage on the scoping predicate (member-performed ∪
 * member-targeted across the two id spaces) + the redaction projection
 * (third-party PII + internal annotations stripped, member's own rows kept).
 */
import { describe, expect, it } from 'vitest';
import {
  buildMemberAuditSubset,
  isInMemberAuditSubset,
  type SubsetSourceRow,
} from '@/modules/insights/application/gdpr-audit-subset';

const MEMBER_USER = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER = '99999999-9999-9999-9999-999999999999';

describe('isInMemberAuditSubset — scoping (100% branch)', () => {
  const scope = { memberUserIds: [MEMBER_USER], memberId: MEMBER_ID };

  it('matches when the member is the actor', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: MEMBER_USER, targetUserId: null, payload: null },
        scope,
      ),
    ).toBe(true);
  });

  it('matches when the member is the target user', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: MEMBER_USER, payload: null },
        scope,
      ),
    ).toBe(true);
  });

  it('matches when payload.member_id is the member', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: null, payload: { member_id: MEMBER_ID } },
        scope,
      ),
    ).toBe(true);
  });

  it('matches when payload.subject_member_id is the member', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: OTHER_USER, payload: { subject_member_id: MEMBER_ID } },
        scope,
      ),
    ).toBe(true);
  });

  it('does NOT match an unrelated row', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: OTHER_USER, payload: { member_id: 'someone-else' } },
        scope,
      ),
    ).toBe(false);
  });

  it('ignores actor/target arms when the member has no portal accounts (empty set)', () => {
    const noAccount = { memberUserIds: [] as string[], memberId: MEMBER_ID };
    // A row authored by some user must NOT match on actor/target when the set is empty …
    expect(
      isInMemberAuditSubset(
        { actorUserId: MEMBER_USER, targetUserId: MEMBER_USER, payload: null },
        noAccount,
      ),
    ).toBe(false);
    // … but a payload member-id match still scopes it in.
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: null, payload: { member_id: MEMBER_ID } },
        noAccount,
      ),
    ).toBe(true);
  });

  it('matches any of several linked colleague user ids', () => {
    const colleague = '88888888-8888-8888-8888-888888888888';
    const multi = { memberUserIds: [MEMBER_USER, colleague], memberId: MEMBER_ID };
    expect(
      isInMemberAuditSubset(
        { actorUserId: colleague, targetUserId: null, payload: null },
        multi,
      ),
    ).toBe(true);
  });

  it('treats a non-string payload value as no match', () => {
    expect(
      isInMemberAuditSubset(
        { actorUserId: OTHER_USER, targetUserId: null, payload: { member_id: 12345 } },
        scope,
      ),
    ).toBe(false);
  });
});

describe('buildMemberAuditSubset — filter + redact', () => {
  const scope = { memberUserIds: [MEMBER_USER], memberId: MEMBER_ID };
  const at = new Date('2026-05-01T10:00:00.000Z');

  const rows: SubsetSourceRow[] = [
    {
      id: 'a1',
      eventType: 'member_self_update',
      summary: 'member updated their profile',
      occurredAt: at,
      actorUserId: MEMBER_USER,
      targetUserId: null,
      payload: { member_id: MEMBER_ID, fields_changed: ['companyName'] },
    },
    {
      id: 'a2',
      eventType: 'member_email_change_requested',
      summary: 'email change requested for old@x.com → new@x.com',
      occurredAt: at,
      actorUserId: MEMBER_USER,
      targetUserId: null,
      payload: { member_id: MEMBER_ID, old_email: 'old@x.com', new_email: 'new@x.com' },
    },
    {
      // Unrelated row — must be filtered out.
      id: 'a3',
      eventType: 'member_created',
      summary: 'created member other',
      occurredAt: at,
      actorUserId: OTHER_USER,
      targetUserId: OTHER_USER,
      payload: { member_id: 'someone-else' },
    },
  ];

  it('keeps only the member-scoped rows', () => {
    const out = buildMemberAuditSubset(rows, scope);
    expect(out.map((e) => e.id)).toEqual(['a1', 'a2']);
  });

  it('strips third-party email payload fields via the standard projection', () => {
    const out = buildMemberAuditSubset(rows, scope);
    const emailRow = out.find((e) => e.id === 'a2');
    expect(emailRow?.payload).not.toHaveProperty('old_email');
    expect(emailRow?.payload).not.toHaveProperty('new_email');
    // The structured member-id stays (accountability + it is the member's own).
    expect(emailRow?.payload).toMatchObject({ member_id: MEMBER_ID });
  });

  it('redacts emails embedded in the free-text summary', () => {
    const out = buildMemberAuditSubset(rows, scope);
    const emailRow = out.find((e) => e.id === 'a2');
    expect(emailRow?.summary).not.toContain('old@x.com');
    expect(emailRow?.summary).toContain('[email redacted]');
  });

  it('emits ISO-8601 occurredAt and drops internal actor/target ids', () => {
    const out = buildMemberAuditSubset(rows, scope);
    expect(out[0]?.occurredAt).toBe('2026-05-01T10:00:00.000Z');
    expect(out[0]).not.toHaveProperty('actorUserId');
    expect(out[0]).not.toHaveProperty('targetUserId');
  });
});

describe('isInMemberAuditSubset — related_member_id (F114 review privacy I-3)', () => {
  it('a staff action ABOUT the member keyed related_member_id is in the subject\'s subset', () => {
    const scope = { memberId: 'm-1', memberUserIds: ['u-1'] };
    const row = {
      actorUserId: 'staff-9',
      targetUserId: null,
      payload: { related_member_id: 'm-1', request_id: 'r-1', outcome: 'rejected' },
    } as unknown as Parameters<typeof isInMemberAuditSubset>[0];
    expect(isInMemberAuditSubset(row, scope as unknown as Parameters<typeof isInMemberAuditSubset>[1])).toBe(true);
    const other = { ...row, payload: { related_member_id: 'm-2' } } as unknown as Parameters<typeof isInMemberAuditSubset>[0];
    expect(isInMemberAuditSubset(other, scope as unknown as Parameters<typeof isInMemberAuditSubset>[1])).toBe(false);
  });
});

// GDPR Art. 15(4) / 20(4) · PDPA §30 — a colleague's own account activity is
// THEIR personal data, not the requesting colleague's. With `viewerUserId` set,
// the subset keeps the requester's own rows in full and company rows without
// any free text that could name another person.
describe('buildMemberAuditSubset — colleague scoping (Art. 15(4))', () => {
  const REQUESTER = '33333333-3333-3333-3333-333333333333';
  const COLLEAGUE = '44444444-4444-4444-4444-444444444444';
  const at = new Date('2026-05-01T10:00:00Z');
  const scope = { memberUserIds: [REQUESTER], memberId: MEMBER_ID, viewerUserId: REQUESTER };

  const rows: SubsetSourceRow[] = [
    // the requester's own login — kept in full
    { id: 'own', eventType: 'sign_in_success', actorUserId: REQUESTER, targetUserId: null, summary: 'Som Chai signed in', occurredAt: at, payload: null },
    // a staff event about a COLLEAGUE's account, keyed to the member
    { id: 'colleague-target', eventType: 'contact_invited', actorUserId: OTHER_USER, targetUserId: COLLEAGUE, summary: 'Invited Anna Lindqvist', occurredAt: at, payload: { member_id: MEMBER_ID, first_name: 'Anna' } },
    // a company change a colleague made — kept, but no names
    { id: 'company', eventType: 'member_updated', actorUserId: COLLEAGUE, targetUserId: null, summary: 'Anna Lindqvist updated Acme Co', occurredAt: at, payload: { member_id: MEMBER_ID, changed_fields: ['website'], contact: { first_name: 'Anna', last_name: 'Lindqvist' } } },
  ];

  it("drops rows about another person's account", () => {
    const out = buildMemberAuditSubset(rows, scope);
    expect(out.map((e) => e.id)).not.toContain('colleague-target');
  });

  it("keeps the requester's own rows with their summary", () => {
    const own = buildMemberAuditSubset(rows, scope).find((e) => e.id === 'own');
    expect(own?.summary).toBe('Som Chai signed in');
  });

  it('keeps company rows but strips the free-text summary and name keys', () => {
    const company = buildMemberAuditSubset(rows, scope).find((e) => e.id === 'company');
    expect(company).toBeDefined();
    expect(company!.summary).toBe('');
    expect(JSON.stringify(company!.payload)).not.toContain('Anna');
    expect(JSON.stringify(company!.payload)).not.toContain('Lindqvist');
    expect(company!.payload).toMatchObject({ changed_fields: ['website'] });
  });

  it('an on-behalf (null) viewer gets company rows only', () => {
    const out = buildMemberAuditSubset(rows, { memberUserIds: [], memberId: MEMBER_ID, viewerUserId: null });
    expect(out.map((e) => e.id)).toEqual(['company']);
    expect(out[0]!.summary).toBe('');
  });
});
