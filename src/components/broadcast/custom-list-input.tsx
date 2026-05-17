'use client';

/**
 * T086 — Custom recipient list input.
 *
 * Textarea: one email per line, ≤ 100 entries. Per-line preview shows
 * lowercase+trim normalisation; per-line validation is done at submit
 * time by the server (`validateCustomRecipients` use-case).
 *
 * Counter live-updates as the user types; cap-exceeded triggers
 * aria-describedby warning + counter colour change.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_ENTRIES = 100;

export interface CustomListInputProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled?: boolean;
}

export function parseLines(raw: string): ReadonlyArray<string> {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// G3 UX hardening — the previous counter was `aria-live="polite"` so
// every keystroke announced "1 / 100", "2 / 100", "3 / 100" — extremely
// disruptive when pasting an entire list. Strategy:
//   - Visible counter is plain (no aria-live) — sighted users can see
//     the count whenever they look.
//   - A SEPARATE off-screen live region only emits text when crossing
//     a meaningful threshold (≥80% cap or over cap) so SR users still
//     get the safety net for "approaching/over the limit" without
//     drowning in per-keystroke chatter.
const THRESHOLD_RATIO = 0.8;

export function CustomListInput({
  value,
  onChange,
  disabled = false,
}: CustomListInputProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const entries = useMemo(() => parseLines(value), [value]);
  const overCap = entries.length > MAX_ENTRIES;
  const nearCap = entries.length >= Math.floor(MAX_ENTRIES * THRESHOLD_RATIO);

  // Threshold-only announcement text; '' when nothing to announce.
  // SR consumers respect `aria-live="polite"` semantics for the
  // hidden region — empty content does not emit.
  const announcement = overCap
    ? `${entries.length} / ${MAX_ENTRIES}`
    : nearCap
      ? `${entries.length} / ${MAX_ENTRIES}`
      : '';

  return (
    <div className="space-y-2">
      <Label htmlFor="custom-recipient-list">{t('customListLabel')}</Label>
      <Textarea
        id="custom-recipient-list"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={6}
        placeholder={t('customListPlaceholder')}
        aria-describedby="custom-recipient-list-help custom-recipient-list-counter"
        className="font-mono text-sm"
      />
      <p
        id="custom-recipient-list-help"
        className="text-xs text-muted-foreground"
      >
        {t('customListHelp')}
      </p>
      <p
        id="custom-recipient-list-counter"
        className={cn(
          'text-xs',
          overCap ? 'font-semibold text-destructive' : 'text-muted-foreground',
        )}
      >
        {entries.length} / {MAX_ENTRIES}
      </p>
      {/* Off-screen live region — only contains text at threshold or
          beyond, so SR users hear "80/100" once (not after every char). */}
      <span
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="custom-list-threshold-announcer"
      >
        {announcement}
      </span>
    </div>
  );
}
