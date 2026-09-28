'use client';

/**
 * 122 US5a — the members filter trigger as the `Admin-members` boards draw it:
 * one compact button reading "<name> <value>" ("Status All ▾"), so three
 * filters and the needs-invite chip share one row on a phone.
 *
 * A native `<select>` lies transparent over the face and does the work: its
 * accessible name is the filter's name, keyboard and screen-reader behaviour
 * are the platform's, and a phone opens its own picker. The face is
 * `aria-hidden` decoration; the focus ring follows the select. A little
 * less side padding on a phone keeps the three on one row down to 375px.
 */
import { ChevronDownIcon } from 'lucide-react';

export interface FilterChipSelectOption {
  readonly value: string;
  readonly label: string;
}

interface FilterChipSelectProps {
  /** The filter's name — visible on the face and the select's accessible name. */
  readonly label: string;
  readonly value: string;
  readonly options: readonly FilterChipSelectOption[];
  readonly onChange: (value: string) => void;
  /** The short word the face shows for the "all" choice ("All"). */
  readonly allLabel: string;
  readonly allValue?: string;
  readonly className?: string;
}

export function FilterChipSelect({
  label,
  value,
  options,
  onChange,
  allLabel,
  allValue = 'all',
  className,
}: FilterChipSelectProps) {
  const current =
    value === allValue ? allLabel : (options.find((o) => o.value === value)?.label ?? value);
  return (
    <span
      className={`relative inline-flex h-[var(--aura-input-height)] min-w-0 items-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-control)] bg-[var(--aura-bg-surface)] text-[length:var(--aura-input-font-size)] text-[var(--aura-fg-primary)] hover:bg-[var(--aura-bg-surface-hover)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--aura-focus-ring)] ${className ?? ''}`}
    >
      <span
        data-filter-face=""
        aria-hidden="true"
        className="pointer-events-none flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap pr-3 pl-3.5 max-sm:pr-2.5 max-sm:pl-3"
      >
        <span className="text-[var(--aura-fg-secondary)]">{label}</span>
        <span className="min-w-0 truncate font-medium">{current}</span>
        <ChevronDownIcon className="ml-auto size-4 shrink-0" />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
