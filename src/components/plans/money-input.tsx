/**
 * T105 — MoneyInput (US2 + US3).
 *
 * Integer-only numeric input that renders the tenant currency symbol
 * as a leading prefix and converts the user's human-facing
 * major-units value (e.g. "36000" THB) to integer minor units
 * (3_600_000 satang) on change.
 *
 * Non-integer / out-of-range / negative inputs are rejected client-
 * side; the backend still re-validates via `planSchema`. This is a
 * UX nicety, not a security boundary.
 *
 * The currency symbol is resolved by the parent component from the
 * tenant fee config (`meta.currency_code`) and passed in as `prefix`
 * so MoneyInput does not need to hard-code the SweCham THB assumption.
 */
'use client';

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface MoneyInputProps {
  /** Current value in integer MINOR units (e.g. satang). */
  readonly value: number | null;
  readonly onChange: (minorUnits: number | null) => void;
  readonly label: string;
  /** Currency prefix rendered before the input (e.g. `฿`, `kr`, `$`). */
  readonly prefix: string;
  /** Optional max in minor units (default 10_000_000_000 = 100M THB). */
  readonly max?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly helpText?: string;
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
  prefix,
  max = DEFAULT_MAX_MINOR_UNITS,
  required = false,
  disabled = false,
  error,
  helpText,
}: MoneyInputProps) {
  const id = useId();

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive ml-1">*</span> : null}
      </Label>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-6 text-center text-base">
          {prefix}
        </span>
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={minorToDisplay(value)}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^\d]/g, '');
            const next = displayToMinor(raw);
            if (next !== null && next > max) return;
            onChange(next);
          }}
          disabled={disabled}
          aria-invalid={Boolean(error)}
        />
      </div>
      {helpText ? (
        <p className="text-muted-foreground text-sm">{helpText}</p>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
