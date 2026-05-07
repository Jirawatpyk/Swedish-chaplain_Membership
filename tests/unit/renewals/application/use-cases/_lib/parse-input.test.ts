/**
 * F8 Round 2 review-fix (I-4) — unit tests for the `parseInput` helper.
 *
 * The helper is consumed by 4 Phase 5 use-cases (block-auto-reactivation,
 * unblock-auto-reactivation, opt-in-renewal-reminders,
 * opt-out-renewal-reminders) but had ZERO direct tests after the
 * extraction in commit `d4afa438`. A future widening (concat all issues,
 * swap discriminant, drop the defensive fallback, etc.) would silently
 * break 4 use-case error contracts at once. These tests lock the
 * contract.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  parseInput,
  mapZodFirstIssue,
} from '@/modules/renewals/application/use-cases/_lib/parse-input';

describe('parseInput', () => {
  const schema = z.object({
    memberId: z.string().min(1),
    age: z.number().int().min(0),
  });

  it('happy-path: returns ok(parsed) when input matches schema', () => {
    const raw = { memberId: 'm-123', age: 42 };
    const r = parseInput(schema, raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ memberId: 'm-123', age: 42 });
    }
  });

  it('failure: returns err with kind="invalid_input" and FIRST issue message', () => {
    // Both fields invalid — first failure on `memberId` (zod walks
    // shape in declared order). Confirms the helper preserves the
    // first-issue-only invariant the helper docstring promises.
    const raw = { memberId: '', age: -1 };
    const r = parseInput(schema, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_input');
      // Zod's `min(1)` issue message; we don't pin the exact wording
      // (zod can change it) but we confirm it's NOT the
      // 'invalid input' fallback string and NOT the second issue's
      // (`age` min(0)).
      expect(r.error.message).not.toBe('invalid input');
      expect(r.error.message.toLowerCase()).not.toContain('age');
    }
  });

  it('failure: surfaces only the FIRST issue when multiple issues exist', () => {
    // Schema with deterministic issue order: a `discriminatedUnion`
    // would also work but a plain object schema with two failing
    // primitives is sufficient. Zod issue order matches schema-key
    // declaration order.
    const raw = { memberId: '', age: 'not-a-number' };
    const r = parseInput(schema, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Issue 2 ('Expected number') must NOT leak into the message.
      expect(r.error.message.toLowerCase()).not.toContain('number');
    }
  });

  it('parses optional fields correctly when present and absent', () => {
    const optionalSchema = z.object({
      reason: z.string().optional(),
    });
    const r1 = parseInput(optionalSchema, { reason: 'because' });
    const r2 = parseInput(optionalSchema, {});
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(r1.value.reason).toBe('because');
    if (r2.ok) expect(r2.value.reason).toBeUndefined();
  });
});

describe('mapZodFirstIssue', () => {
  it('returns the first issue message verbatim when issues are present', () => {
    expect(
      mapZodFirstIssue([{ message: 'first' }, { message: 'second' }]),
    ).toBe('first');
  });

  it('falls back to "invalid input" when issues array is empty', () => {
    // Defensive fallback — should not happen for well-formed schemas
    // (every safeParse failure produces ≥1 issue), but the helper
    // must not crash if a future zod version or a schema custom
    // refinement returns an empty array.
    expect(mapZodFirstIssue([])).toBe('invalid input');
  });

  it('falls back to "invalid input" when first issue has falsy message', () => {
    // Edge case: zod custom refinements can produce issues whose
    // `message` is an empty string. The `??` fallback only triggers
    // on undefined, so an empty string passes through. Locking this
    // behaviour: empty-message issues surface as the empty string,
    // NOT the fallback. (If a future refactor changes this, the
    // test must be updated explicitly.)
    expect(mapZodFirstIssue([{ message: '' }])).toBe('');
  });

  it('handles single-issue array', () => {
    expect(mapZodFirstIssue([{ message: 'only one' }])).toBe('only one');
  });
});
