/**
 * PR-3 review B7 — `src/lib/http/read-only-refusal.ts`, the one place that
 * knows the READ_ONLY_MODE refusal's two body shapes and two spellings.
 *
 * Six client components carried a hand-written copy of this narrowing. Each
 * copy had to get all four combinations right, and a caller that gets one
 * wrong shows the operator "save failed, try again" during a write freeze —
 * advice that cannot work until the freeze lifts. Pinned here so the next
 * caller composes instead of copying:
 *
 *   - both shapes (`{ error: 'x' }`, `{ error: { code: 'x' } }`) and both
 *     spellings (`read_only_mode`, `read-only-mode`);
 *   - every non-body (`null`, a string, an array, a number) is `null`, never
 *     a coerced value — a malformed body must not read as a known code;
 *   - `isReadOnlyRefusal` also requires the 503, `isReadOnlyCode` does not:
 *     the split is what let the five ladder callers keep branching on the
 *     code alone, byte-identically.
 */
import { describe, expect, it } from 'vitest';
import { isReadOnlyCode, isReadOnlyRefusal, problemCode, readProblemCode } from '@/lib/http/read-only-refusal';

describe('readProblemCode — the SHAPE is which layer refused (A1)', () => {
  it('a route handler answers flat; a guard in front of it answers nested', () => {
    expect(readProblemCode({ error: 'not_found' })).toEqual({ code: 'not_found', shape: 'flat' });
    expect(readProblemCode({ error: { code: 'not_found', message: 'No linked member found' } })).toEqual({ code: 'not_found', shape: 'nested' });
  });

  it('the two envelopes spell the SAME code — only the shape separates them', () => {
    const flat = readProblemCode({ error: 'not_found' })!;
    const nested = readProblemCode({ error: { code: 'not_found' } })!;
    expect(flat.code).toBe(nested.code);
    expect(flat.shape).not.toBe(nested.shape);
  });

  it('a body with no code carries no shape either', () => {
    for (const body of [null, {}, { error: {} }, { error: 42 }, '<html>']) {
      expect(readProblemCode(body), JSON.stringify(body) ?? 'null').toBeNull();
    }
  });
});

describe('problemCode', () => {
  it('reads the FLAT proxy shape and the NESTED route-guard shape', () => {
    expect(problemCode({ error: 'read-only-mode' })).toBe('read-only-mode');
    expect(problemCode({ error: { code: 'read_only_mode', message: 'maintenance' } })).toBe('read_only_mode');
    expect(problemCode({ error: 'plan_has_active_members' })).toBe('plan_has_active_members');
    expect(problemCode({ error: { code: 'not_found' } })).toBe('not_found');
  });

  it('answers null for every body that carries no code — never a coerced string', () => {
    for (const body of [null, undefined, '', 'read-only-mode', 42, [], {}, { error: null }, { error: 42 }, { error: {} }, { error: { code: 7 } }]) {
      expect(problemCode(body), JSON.stringify(body) ?? 'undefined').toBeNull();
    }
  });
});

describe('isReadOnlyCode', () => {
  it('accepts both spellings and nothing else', () => {
    expect(isReadOnlyCode('read_only_mode')).toBe(true);
    expect(isReadOnlyCode('read-only-mode')).toBe(true);
    for (const code of [null, undefined, '', 'generic', 'readonly', 'read only mode', 'READ_ONLY_MODE']) {
      expect(isReadOnlyCode(code), String(code)).toBe(false);
    }
  });
});

describe('isReadOnlyRefusal', () => {
  it('is true only for a 503 whose body carries the refusal', () => {
    expect(isReadOnlyRefusal(503, { error: 'read-only-mode' })).toBe(true);
    expect(isReadOnlyRefusal(503, { error: { code: 'read_only_mode' } })).toBe(true);
  });

  it('a non-503 carrying the code is NOT the freeze — the status is part of the question', () => {
    expect(isReadOnlyRefusal(500, { error: 'read-only-mode' })).toBe(false);
    expect(isReadOnlyRefusal(200, { error: { code: 'read_only_mode' } })).toBe(false);
  });

  it('a 503 that is NOT the freeze (a plain upstream outage, an HTML body) is false', () => {
    expect(isReadOnlyRefusal(503, { error: 'upstream_unavailable' })).toBe(false);
    expect(isReadOnlyRefusal(503, null)).toBe(false);
    expect(isReadOnlyRefusal(503, {})).toBe(false);
  });
});
