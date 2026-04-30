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

export function CustomListInput({
  value,
  onChange,
  disabled = false,
}: CustomListInputProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const entries = useMemo(() => parseLines(value), [value]);
  const overCap = entries.length > MAX_ENTRIES;

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
        aria-live="polite"
      >
        {entries.length} / {MAX_ENTRIES}
      </p>
    </div>
  );
}
