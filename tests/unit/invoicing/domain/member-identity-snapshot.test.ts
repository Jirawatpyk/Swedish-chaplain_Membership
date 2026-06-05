/**
 * Unit tests for MemberIdentitySnapshot zod schema + MalformedSnapshotError.
 * T082 architect-review 2026-04-24: runtime validation at the repo
 * row→Domain boundary, paired with migration 0045's DB CHECK.
 */
import { describe, it, expect } from 'vitest';
import {
  memberIdentitySnapshotSchema,
  MalformedSnapshotError,
  InvalidMemberIdentitySnapshotError,
  makeMemberIdentitySnapshot,
  type MemberIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

const validSnapshot: MemberIdentitySnapshot = {
  legal_name: 'SweCham Alpha Co., Ltd.',
  tax_id: '0105562000123',
  address: '99/1 Rama IV, Bangkok',
  primary_contact_name: 'E2E Alpha',
  primary_contact_email: 'e2e-member@swecham.test',
  // 055-member-number — the snapshot interface now carries BOTH the bare
  // member_number AND the formatted member_number_display. Default fixtures pin
  // both null (event/non-member shape); cases that exercise a real member spread
  // `{ ...validSnapshot, member_number: 42, member_number_display: 'SCCM-0042' }`.
  member_number: null,
  member_number_display: null,
};

describe('memberIdentitySnapshotSchema (architect-review 2026-04-24)', () => {
  it('parses a fully-populated snapshot', () => {
    const result = memberIdentitySnapshotSchema.safeParse(validSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.primary_contact_email).toBe(
        'e2e-member@swecham.test',
      );
      expect(result.data.tax_id).toBe('0105562000123');
    }
  });

  it('accepts null tax_id for individual (non-corporate) members', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      tax_id: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty-string tax_id (callers must use null explicitly)', () => {
    // Thai business context: corporate → 13-digit TIN, individual →
    // null. Empty string is ambiguous — reject so downstream renderers
    // can branch safely on "no TIN" vs "corrupt TIN".
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      tax_id: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing primary_contact_email (the original T082 bug)', () => {
    const { primary_contact_email: _omit, ...rest } = validSnapshot;
    void _omit;
    const result = memberIdentitySnapshotSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      const pathHit = result.error.issues.some(
        (i) => i.path[0] === 'primary_contact_email',
      );
      expect(pathHit).toBe(true);
    }
  });

  it('rejects an undefined primary_contact_email', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      primary_contact_email: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-email primary_contact_email', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      primary_contact_email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty legal_name', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      legal_name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty address', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      address: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing primary_contact_name', () => {
    const { primary_contact_name: _omit, ...rest } = validSnapshot;
    void _omit;
    const result = memberIdentitySnapshotSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('parses through unknown additional keys (schema is additive-tolerant)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      unknown_future_field: 'ok',
    });
    expect(result.success).toBe(true);
  });
});

describe('MalformedSnapshotError', () => {
  it('carries the invoiceId + zod issues for ops triage', () => {
    const parsed = memberIdentitySnapshotSchema.safeParse({
      legal_name: '',
      tax_id: null,
      address: 'ok',
      primary_contact_name: 'ok',
      primary_contact_email: 'not-email',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const err = new MalformedSnapshotError(
        'inv_test_001',
        parsed.error.issues,
      );
      expect(err.kind).toBe('malformed_snapshot');
      expect(err.invoiceId).toBe('inv_test_001');
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.message).toContain('inv_test_001');
      expect(err.message).toContain('member_identity_snapshot');
    }
  });

  it('is an Error instance (toolchain compat)', () => {
    const err = new MalformedSnapshotError('inv_x', []);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof MalformedSnapshotError).toBe(true);
  });
});

describe('makeMemberIdentitySnapshot', () => {
  it('freezes the returned object (FR-038 immutability at Domain layer)', () => {
    const snap = makeMemberIdentitySnapshot(validSnapshot);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  // code-review L-03 — validate at creation (defense-in-depth).
  it('throws InvalidMemberIdentitySnapshotError on an empty address', () => {
    expect(() =>
      makeMemberIdentitySnapshot({ ...validSnapshot, address: '' }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('throws on a malformed primary_contact_email', () => {
    expect(() =>
      makeMemberIdentitySnapshot({
        ...validSnapshot,
        primary_contact_email: 'not-an-email',
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('throws on an empty legal_name', () => {
    expect(() =>
      makeMemberIdentitySnapshot({ ...validSnapshot, legal_name: '' }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('throws on an empty-string tax_id (must be null when absent, not "")', () => {
    expect(() =>
      makeMemberIdentitySnapshot({ ...validSnapshot, tax_id: '' }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('accepts a valid snapshot with null tax_id (individual member)', () => {
    const snap = makeMemberIdentitySnapshot({ ...validSnapshot, tax_id: null });
    expect(snap.tax_id).toBeNull();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('accepts a CONTACTLESS member (empty name + empty email) — §86/4 needs no buyer contact', () => {
    const snap = makeMemberIdentitySnapshot({
      ...validSnapshot,
      primary_contact_name: '',
      primary_contact_email: '',
    });
    expect(snap.primary_contact_name).toBe('');
    expect(snap.primary_contact_email).toBe('');
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('surfaces the zod issues on the thrown error', () => {
    try {
      makeMemberIdentitySnapshot({ ...validSnapshot, address: '' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMemberIdentitySnapshotError);
      if (e instanceof InvalidMemberIdentitySnapshotError) {
        expect(e.issues.length).toBeGreaterThan(0);
        expect(e.kind).toBe('invalid_member_identity_snapshot');
      }
    }
  });
});

// ── 055-member-number: snapshot carries an optional member_number ──
describe('member_number on memberIdentitySnapshotSchema (055-member-number)', () => {
  it('parses and KEEPS a positive integer member_number (strip-regression — zod must declare the key)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // If the field is on the interface but NOT the schema, z.object strips
      // it → this is `undefined` and the assertion fails. This is the guard.
      expect(result.data.member_number).toBe(42);
    }
  });

  it('defaults a MISSING member_number key to null (historical snapshot)', () => {
    // A pre-feature JSONB snapshot has no key at all → .optional().default(null)
    // resolves to null (NOT undefined), satisfying exactOptionalPropertyTypes.
    // Strip the key from the typed fixture to faithfully model a key-absent row.
    const { member_number: _omit, ...noKey } = validSnapshot;
    void _omit;
    const result = memberIdentitySnapshotSchema.safeParse(noKey);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.member_number).toBeNull();
    }
  });

  it('accepts an explicit null member_number (event / non-member buyer)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.member_number).toBeNull();
  });

  it('rejects a zero / negative member_number (positive constraint)', () => {
    expect(
      memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: 0 }).success,
    ).toBe(false);
    expect(
      memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: -1 }).success,
    ).toBe(false);
  });

  it('rejects a fractional member_number (integer constraint)', () => {
    expect(
      memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: 1.5 }).success,
    ).toBe(false);
  });
});

describe('makeMemberIdentitySnapshot member_number (055-member-number)', () => {
  it('keeps member_number 42 through make() (strip-regression at creation)', () => {
    const snap = makeMemberIdentitySnapshot({ ...validSnapshot, member_number: 42 });
    expect(snap.member_number).toBe(42);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('defaults member_number to null when the caller omits it', () => {
    // Key-absent input (pre-feature snapshot shape) → make() applies .default(null).
    const { member_number: _omit, ...noKey } = validSnapshot;
    void _omit;
    const snap = makeMemberIdentitySnapshot(noKey as MemberIdentitySnapshot);
    expect(snap.member_number).toBeNull();
  });
});

// ── 055-member-number: snapshot carries the FORMATTED display string ──
describe('member_number_display on memberIdentitySnapshotSchema (055-member-number)', () => {
  it('parses and KEEPS a formatted display string (strip-regression — zod must declare the key)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
      member_number_display: 'SCCM-0042',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // If the field is on the interface but NOT the schema, z.object strips
      // it → this is `undefined` and the assertion fails. This is the guard.
      expect(result.data.member_number_display).toBe('SCCM-0042');
    }
  });

  it('defaults a MISSING member_number_display key to null (historical snapshot)', () => {
    // A pre-feature JSONB snapshot has no key → .optional().default(null)
    // resolves to null (NOT undefined), so the PDF template omits the line.
    const { member_number_display: _omit, ...noKey } = validSnapshot;
    void _omit;
    const result = memberIdentitySnapshotSchema.safeParse(noKey);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.member_number_display).toBeNull();
    }
  });

  it('accepts an explicit null member_number_display (event / non-member buyer)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number_display: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.member_number_display).toBeNull();
  });

  it('rejects an empty-string member_number_display (must be null when absent)', () => {
    // Mirrors the tax_id posture: an empty string is ambiguous — callers pick
    // null explicitly so the template can branch on "no number" unambiguously.
    expect(
      memberIdentitySnapshotSchema.safeParse({
        ...validSnapshot,
        member_number_display: '',
      }).success,
    ).toBe(false);
  });
});

describe('makeMemberIdentitySnapshot member_number_display (055-member-number)', () => {
  it('keeps the formatted display string through make() (strip-regression at creation)', () => {
    const snap = makeMemberIdentitySnapshot({
      ...validSnapshot,
      member_number: 42,
      member_number_display: 'SCCM-0042',
    });
    expect(snap.member_number_display).toBe('SCCM-0042');
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('defaults member_number_display to null when the caller omits it', () => {
    const { member_number_display: _omit, ...noKey } = validSnapshot;
    void _omit;
    const snap = makeMemberIdentitySnapshot(noKey as MemberIdentitySnapshot);
    expect(snap.member_number_display).toBeNull();
  });
});
