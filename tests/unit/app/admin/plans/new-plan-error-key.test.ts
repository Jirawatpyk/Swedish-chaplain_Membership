/**
 * new-plan create-error → i18n key mapping (regression guard).
 *
 * `POST /api/plans` returns snake_case error codes; `new-plan-client` looks up
 * `admin.plans.errors.<code>` and falls back to `errors.generic` on a miss.
 * Several codes differ from (or have no) same-named i18n key and previously
 * produced the generic "Something went wrong." toast (F2 UAT TC-PLAN-14;
 * `duplicate_plan` fixed in PR #137). These tests pin the mapping AND that each
 * target key still exists in en.json, so a rename on either side re-surfaces
 * the bug at CI time.
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

  it('maps invalid_body and partnership_corporate_mismatch → validation', () => {
    expect(resolvePlanCreateErrorKey('invalid_body')).toBe('validation');
    expect(resolvePlanCreateErrorKey('partnership_corporate_mismatch')).toBe(
      'validation',
    );
  });

  it('maps every known create error code to an i18n key', () => {
    expect(PLAN_CREATE_ERROR_KEY_MAP).toEqual({
      duplicate_plan: 'duplicateKey',
      idempotency_conflict: 'idempotencyConflict',
      invalid_body: 'validation',
      partnership_corporate_mismatch: 'validation',
    });
  });

  it('every mapped target key exists under admin.plans.errors in en.json', () => {
    const errors = en.admin.plans.errors as Record<string, string>;
    for (const key of Object.values(PLAN_CREATE_ERROR_KEY_MAP)) {
      expect(key in errors).toBe(true);
    }
  });
});
