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
  readMemberIdentitySnapshot,
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
    // Both fields pinned together (the pairing-refine requires it) — the
    // strip-regression intent is still on `member_number`.
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
      member_number_display: 'SCCM-0042',
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
    // Pinned together with the display string (pairing-refine).
    const snap = makeMemberIdentitySnapshot({
      ...validSnapshot,
      member_number: 42,
      member_number_display: 'SCCM-0042',
    });
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

// ── 055-member-number: member_number + member_number_display are PINNED ──
// The two fields must agree on null-ness: both null (event/non-member buyer
// or historical snapshot) OR both non-null (membership invoice). A half-
// populated snapshot is a representable illegal state that would render an
// inconsistent §86/4 tax document, so the schema rejects it loudly.
describe('member_number / member_number_display pairing (055-member-number)', () => {
  it('rejects a half-populated snapshot: member_number set, display null', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
      member_number_display: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const pathHit = result.error.issues.some(
        (i) => i.path[0] === 'member_number_display',
      );
      expect(pathHit).toBe(true);
    }
  });

  it('rejects a half-populated snapshot: display set, member_number null', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: null,
      member_number_display: 'SCCM-0042',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a half-populated snapshot when one key is ABSENT (default null) and the other is set', () => {
    // A snapshot that carries member_number but omits the display key entirely
    // (the default supplies null) is still half-populated → reject.
    const { member_number_display: _omit, ...noDisplay } = validSnapshot;
    void _omit;
    const result = memberIdentitySnapshotSchema.safeParse({
      ...noDisplay,
      member_number: 42,
    });
    expect(result.success).toBe(false);
  });

  it('accepts both-null (event / non-member / historical)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: null,
      member_number_display: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts both-non-null (membership invoice)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
      member_number_display: 'SCCM-0042',
    });
    expect(result.success).toBe(true);
  });

  it('makeMemberIdentitySnapshot throws on a half-populated snapshot', () => {
    expect(() =>
      makeMemberIdentitySnapshot({
        ...validSnapshot,
        member_number: 42,
        member_number_display: null,
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });
});

// ── 088-invoice-tax-flow-redesign (T010, § C.1 / § F.1) ──
// The snapshot carries the buyer §86/4 Head-Office/Branch particular + the
// VAT-registrant discriminator (the actual branch-line render gate). All three
// keys are `.optional().default(…)` and fail closed: a MISSING key resolves to
// head-office / null / NOT-registrant (never `buyerHasTin`). The head-office ⇔
// branch-code pair is pinned by a superRefine.
describe('buyer branch + VAT-registrant fields (088-invoice-tax-flow-redesign)', () => {
  it('defaults MISSING keys to head-office / null / not-registrant (fail-closed)', () => {
    // validSnapshot omits all three keys — models a pre-088 historical snapshot.
    const result = memberIdentitySnapshotSchema.safeParse(validSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.buyer_is_head_office).toBe(true);
      expect(result.data.buyer_branch_code).toBeNull();
      expect(result.data.buyer_is_vat_registrant).toBe(false);
    }
  });

  it('KEEPS an explicit branch (head-office=false + 5-digit code) — strip-regression', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      buyer_is_head_office: false,
      buyer_branch_code: '00005',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // If the field were on the interface but NOT the schema, z.object strips it.
      expect(result.data.buyer_branch_code).toBe('00005');
      expect(result.data.buyer_is_head_office).toBe(false);
    }
  });

  it('KEEPS an explicit buyer_is_vat_registrant=true (render gate) — strip-regression', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      buyer_is_vat_registrant: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.buyer_is_vat_registrant).toBe(true);
  });

  it('rejects a head-office buyer carrying a branch_code (pairing violation)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      buyer_is_head_office: true,
      buyer_branch_code: '00005',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === 'buyer_branch_code'),
      ).toBe(true);
    }
  });

  it('rejects a branch buyer with a null branch_code (pairing violation)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      buyer_is_head_office: false,
      buyer_branch_code: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-5-digit branch_code', () => {
    expect(
      memberIdentitySnapshotSchema.safeParse({
        ...validSnapshot,
        buyer_is_head_office: false,
        buyer_branch_code: '5',
      }).success,
    ).toBe(false);
    expect(
      memberIdentitySnapshotSchema.safeParse({
        ...validSnapshot,
        buyer_is_head_office: false,
        buyer_branch_code: 'ABCDE',
      }).success,
    ).toBe(false);
  });

  it('makeMemberIdentitySnapshot keeps a valid branch + registrant flag', () => {
    const snap = makeMemberIdentitySnapshot({
      ...validSnapshot,
      buyer_is_head_office: false,
      buyer_branch_code: '00012',
      buyer_is_vat_registrant: true,
    });
    expect(snap.buyer_branch_code).toBe('00012');
    expect(snap.buyer_is_head_office).toBe(false);
    expect(snap.buyer_is_vat_registrant).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('makeMemberIdentitySnapshot throws on a head-office buyer with a branch_code', () => {
    expect(() =>
      makeMemberIdentitySnapshot({
        ...validSnapshot,
        buyer_is_head_office: true,
        buyer_branch_code: '00005',
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });
});

// ── 059 / PR-A Task 4 — the registrant ⇒ TIN invariant ──
// ประกาศอธิบดีฯ 196 (buyer TIN) + 199 (สำนักงานใหญ่/สาขาที่ NNNNN) are a PAIR —
// both mandatory when the buyer is a VAT registrant. THIS is the last gate
// before an immutable tax document exists (create-member.ts / update-member.ts
// / the form schema are UX that surface the problem earlier — none of them
// replaces this one). A snapshot with `buyer_is_vat_registrant: true` and
// `tax_id: null` must fail loud, not degrade into a defective §86/4 document.
describe('registrant ⇒ TIN invariant (059 / PR-A Task 4)', () => {
  it('the WRITE path rejects buyer_is_vat_registrant=true with a null tax_id', () => {
    expect(() =>
      makeMemberIdentitySnapshot({
        ...validSnapshot,
        tax_id: null,
        buyer_is_vat_registrant: true,
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('readMemberIdentitySnapshot ACCEPTS that shape — this is the constructor the repos must use', () => {
    // The row-mappers in drizzle-invoice-repo and drizzle-credit-note-repo call
    // THIS function, not `makeMemberIdentitySnapshot`. If someone swaps them
    // back, a document issued under the old rules becomes unreadable and one such
    // row 500s the whole invoice list page.
    //
    // That is not hypothetical: it shipped TWICE on this branch. First the rule
    // lived in the schema's `superRefine` (which the row-mappers run). Moving it
    // into `makeMemberIdentitySnapshot` did NOT fix it, because BOTH row-mappers
    // were still CALLING that constructor — the invoice repo wrapped its own
    // parse in it, the credit-note repo used it directly. Only splitting the
    // read constructor out actually closed it.
    const snap = readMemberIdentitySnapshot({
      ...validSnapshot,
      tax_id: null,
      buyer_is_vat_registrant: true,
    });
    expect(snap.buyer_is_vat_registrant).toBe(true);
    expect(snap.tax_id).toBeNull();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('the READ path ACCEPTS that shape — an already-issued document must stay readable', () => {
    // The invariant is a WRITE rule, and it lives in `makeMemberIdentitySnapshot`,
    // NOT in the schema's superRefine. This test is the reason.
    //
    // `memberIdentitySnapshotSchema` is ALSO the read boundary: DrizzleInvoiceRepo's
    // `parseMemberIdentitySnapshot` runs it over the frozen JSONB of every invoice
    // row, and `list()` / `listPaged()` map rows with no per-row guard. Putting the
    // rule in the shared schema made it RETROACTIVE — a document issued under the
    // old rules (the deleted guess inferred `buyer_is_vat_registrant` from
    // `legal_entity_type` alone, never consulting `tax_id`) becomes unparseable,
    // and ONE such row takes down the entire invoice list page: an unhandled 500,
    // no error code, no audit trail. That is the exact class of silent failure this
    // branch exists to remove, reintroduced by the branch's own new rule.
    //
    // Same principle the templateVersion gate encodes for rendering: a document
    // already issued must remain readable and reproducible forever. A constraint on
    // what we may CREATE must never invalidate what we already WROTE. Correcting a
    // historical particular is a credit note (§86/10) — not a parse error on
    // someone's invoice list.
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      tax_id: null,
      buyer_is_vat_registrant: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts buyer_is_vat_registrant=true WITH a tax_id on the raw schema', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      tax_id: '0105562000123',
      buyer_is_vat_registrant: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts buyer_is_vat_registrant=false with a null tax_id on the raw schema', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      tax_id: null,
      buyer_is_vat_registrant: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a VAT registrant with no TIN', () => {
    // ประกาศ 196 + 199 are a PAIR: a registrant buyer must carry BOTH the
    // 13-digit TIN and the head-office/branch line. Printing one without the
    // other is a defective §86/4 document. This must fail LOUD at issue — it
    // is the last gate before the document exists.
    expect(() =>
      makeMemberIdentitySnapshot({
        legal_name: 'ACME Co., Ltd.',
        tax_id: null,
        address: '123 Sukhumvit',
        primary_contact_name: 'Somchai',
        primary_contact_email: 'a@b.com',
        buyer_is_vat_registrant: true,
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('accepts a NON-registrant with no TIN', () => {
    // The common case: a foreign member, or a Thai member below the threshold.
    // No TIN is required of them, and no branch line prints.
    expect(() =>
      makeMemberIdentitySnapshot({
        legal_name: 'Nordic AB',
        tax_id: null,
        address: 'Stockholm',
        primary_contact_name: 'Anders',
        primary_contact_email: 'a@b.se',
        buyer_is_vat_registrant: false,
      }),
    ).not.toThrow();
  });

  it('accepts a VAT registrant WITH a TIN', () => {
    expect(() =>
      makeMemberIdentitySnapshot({
        ...validSnapshot,
        tax_id: '0105562000123',
        buyer_is_vat_registrant: true,
      }),
    ).not.toThrow();
  });
});
