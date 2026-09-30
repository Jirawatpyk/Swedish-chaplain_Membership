/**
 * T105 — MoneyInput (US2 + US3).
 *
 * Integer-only numeric input that converts the user's human-facing
 * major-units value (e.g. "36000" THB) to integer minor units
 * (3_600_000 satang) on change.
 *
 * Non-integer / out-of-range / negative inputs are rejected client-
 * side; the backend still re-validates via `planSchema`. This is a
 * UX nicety, not a security boundary.
 *
 * The currency unit is resolved by the parent component from the tenant
 * fee config (`meta.currency_code`) and passed in as `unit`, so MoneyInput
 * does not hard-code the SweCham THB assumption.
 *
 * 122 US6 (T604): an AURA `TextField` with the currency code as its suffix
 * ("36000 THB", as the product writes amounts); on a prior-year plan it is
 * read-only with AURA's lock icon (spec Clarifications, US6 start).
 */
'use client';

import { TextField } from '@jirawatpyk/aura-react';
import { lockedFieldProps } from './plan-locked-note';

export interface MoneyInputProps {
  /** Current value in integer MINOR units (e.g. satang). */
  readonly value: number | null;
  readonly onChange: (minorUnits: number | null) => void;
  readonly label: string;
  /** Currency unit shown after the value (e.g. `THB`). */
  readonly unit: string;
  /** Optional max in minor units (default 10_000_000_000 = 100M THB). */
  readonly max?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /** A prior-year plan's locked field: read-only, with the lock icon. */
  readonly locked?: boolean;
  readonly error?: string;
  readonly helpText?: string;
  readonly id?: string;
}

const DEFAULT_MAX_MINOR_UNITS = 10_000_000_000;

function minorToDisplay(minor: number | null): string {
  if (minor === null) return '';
  return String(Math.round(minor / 100));
}

function displayToMinor(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10) * 100;
}

export function MoneyInput({
  value,
  onChange,
  label,
  unit,
  max = DEFAULT_MAX_MINOR_UNITS,
  required = false,
  disabled = false,
  locked = false,
  error,
  helpText,
  id,
}: MoneyInputProps) {
  return (
    <TextField
      {...(id ? { id } : {})}
      label={label}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      suffix={unit}
      value={minorToDisplay(value)}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, '');
        const next = displayToMinor(raw);
        if (next !== null && next > max) return;
        onChange(next);
      }}
      disabled={disabled}
      {...(required ? { required: true } : {})}
      {...(helpText ? { hint: helpText } : {})}
      {...(error ? { error } : {})}
      {...lockedFieldProps(locked)}
    />
  );
}
