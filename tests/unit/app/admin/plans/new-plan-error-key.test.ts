/**
 * new-plan create-error → i18n key mapping (regression guard).
 *
 * `POST /api/plans` returns snake_case error codes; `new-plan-client` looks up
 * `admin.plans.errors.<code>` and falls back to `errors.generic` on a miss. Two
 * 409 codes are spelled differently from their i18n key and previously produced
 * the generic "Something went wrong." toast instead of their specific message
 * (F2 UAT TC-PLAN-14; `duplicate_plan` fixed in PR #137, `idempotency_conflict`
 * here). These tests pin the mapping AND that each target key still exists in
 * en.json, so a rename on either side re-surfaces the bug at CI time.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import {
  PLAN_CREATE_ERROR_KEY_MAP,
  resolvePlanCreateErrorKey,
} from '@/app/(staff)/admin/plans/new/error-key';

describe('resolvePlanCreateErrorKey', () => {
  it('maps duplicate_plan → duplicateKey', () => {
    expect(resolvePlanCreateErrorKey('duplicate_plan')).toBe('duplicateKey');
  });

  it('maps idempotency_conflict → idempotencyConflict', () => {
    expect(resolvePlanCreateErrorKey('idempotency_conflict')).toBe(
      'idempotencyConflict',
    );
  });

  it('passes an already-matching code through unchanged', () => {
    expect(resolvePlanCreateErrorKey('validation')).toBe('validation');
    expect(resolvePlanCreateErrorKey('forbidden')).toBe('forbidden');
  });

  it('passes an unknown code through unchanged (caller falls back to generic)', () => {
    expect(resolvePlanCreateErrorKey('totally_unknown_code')).toBe(
      'totally_unknown_code',
    );
    expect(resolvePlanCreateErrorKey('generic')).toBe('generic');
  });

  it('has exactly the two known snake↔camel mismatches mapped', () => {
    expect(PLAN_CREATE_ERROR_KEY_MAP).toEqual({
      duplicate_plan: 'duplicateKey',
      idempotency_conflict: 'idempotencyConflict',
    });
  });

  it('every mapped target key exists under admin.plans.errors in en.json', () => {
    const errors = en.admin.plans.errors as Record<string, string>;
    for (const key of Object.values(PLAN_CREATE_ERROR_KEY_MAP)) {
      expect(key in errors).toBe(true);
    }
  });
});
