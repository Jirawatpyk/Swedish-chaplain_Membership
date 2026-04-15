/**
 * OverrideReason — audit-preserving admin override of a validation warning.
 *
 * Per FR-006a: when an admin bypasses turnover-band / age / startup-duration
 * validation, they must record an override reason from a fixed enum. The
 * `other` branch requires a free-text note (1..500 chars). Other branches
 * may optionally carry a note.
 *
 * The full object is embedded in the audit-log payload so compliance
 * reviewers can reconstruct why a value was accepted.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

export const OVERRIDE_REASON_CODES = [
  'board_approved',
  'pending_renewal_grace',
  'data_correction',
  'other',
] as const;

export type OverrideReasonCode = (typeof OVERRIDE_REASON_CODES)[number];

export type OverrideReason = {
  readonly code: OverrideReasonCode;
  readonly note: string | null;
};

export type OverrideReasonError =
  | { code: 'override.invalid_code' }
  | { code: 'override.note_required_for_other' }
  | { code: 'override.note_too_long'; maxLength: 500 };

export function asOverrideReason(
  code: string,
  note: string | null | undefined,
): Result<OverrideReason, OverrideReasonError> {
  if (!(OVERRIDE_REASON_CODES as readonly string[]).includes(code))
    return err({ code: 'override.invalid_code' });

  const trimmed = note?.trim() ?? '';
  if (trimmed.length > 500)
    return err({ code: 'override.note_too_long', maxLength: 500 });

  if (code === 'other' && trimmed.length === 0)
    return err({ code: 'override.note_required_for_other' });

  return ok({
    code: code as OverrideReasonCode,
    note: trimmed.length === 0 ? null : trimmed,
  });
}

export function isOverrideReasonCode(
  value: unknown,
): value is OverrideReasonCode {
  return (
    typeof value === 'string' &&
    (OVERRIDE_REASON_CODES as readonly string[]).includes(value)
  );
}
