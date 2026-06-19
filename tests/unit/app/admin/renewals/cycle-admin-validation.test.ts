/**
 * DV-5 — pure validation-predicate unit coverage for the cancel-cycle +
 * mark-paid-offline forms. These predicates were extracted from
 * `<CycleAdminActions>` precisely so they can be exercised here WITHOUT
 * rendering the Base UI dialogs (which deadlock under jsdom + React 19
 * `startTransition` — the dialog-jsdom-hang memory). The dialog INTERACTION
 * (open → fill → submit) is covered by
 * `tests/e2e/renewal-admin-actions.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  isCancelReasonInvalid,
  isMarkPaidIncomplete,
  REASON_MAX,
  REASON_MIN,
} from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-validation';

describe('isCancelReasonInvalid (DV-5)', () => {
  it('is invalid for an empty / whitespace-only reason', () => {
    expect(isCancelReasonInvalid('')).toBe(true);
    expect(isCancelReasonInvalid('   ')).toBe(true);
    expect(isCancelReasonInvalid('\n\t ')).toBe(true);
  });

  it('is valid at the lower bound (1 char after trim)', () => {
    expect(REASON_MIN).toBe(1);
    expect(isCancelReasonInvalid('x')).toBe(false);
    expect(isCancelReasonInvalid('  x  ')).toBe(false);
  });

  it('is valid at exactly REASON_MAX and invalid one char over', () => {
    expect(isCancelReasonInvalid('a'.repeat(REASON_MAX))).toBe(false);
    expect(isCancelReasonInvalid('a'.repeat(REASON_MAX + 1))).toBe(true);
  });

  it('counts the TRIMMED length (surrounding space does not pad to valid)', () => {
    // 500 'a' with surrounding spaces still trims to exactly REASON_MAX →
    // valid; 501 'a' trims to over-cap → invalid regardless of the spaces.
    expect(isCancelReasonInvalid(`  ${'a'.repeat(REASON_MAX)}  `)).toBe(false);
    expect(isCancelReasonInvalid(`  ${'a'.repeat(REASON_MAX + 1)}  `)).toBe(
      true,
    );
  });
});

describe('isMarkPaidIncomplete (DV-5)', () => {
  it('is incomplete when the reference is empty / whitespace-only', () => {
    expect(isMarkPaidIncomplete('', '2026-01-15')).toBe(true);
    expect(isMarkPaidIncomplete('   ', '2026-01-15')).toBe(true);
  });

  it('is incomplete when the date is empty', () => {
    expect(isMarkPaidIncomplete('slip-001', '')).toBe(true);
  });

  it('is incomplete when both fields are empty', () => {
    expect(isMarkPaidIncomplete('', '')).toBe(true);
  });

  it('is complete when both reference and date are present', () => {
    expect(isMarkPaidIncomplete('slip-001', '2026-01-15')).toBe(false);
    expect(isMarkPaidIncomplete('  slip-001  ', '2026-01-15')).toBe(false);
  });
});
