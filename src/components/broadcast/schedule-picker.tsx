'use client';

/**
 * T087 — Schedule picker (optional future-send).
 *
 * Single `<input type="datetime-local">` paired with a "Send for review
 * immediately" checkbox. When checked, the input is disabled and value
 * cleared. TH locale displays the current selection in Buddhist Era
 * via `Intl.DateTimeFormat('th-TH-u-ca-buddhist')` for a confirmation
 * helper; the underlying value remains ISO-8601 UTC.
 */
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

export interface SchedulePickerProps {
  /** ISO-8601 UTC string or null when "send immediately" is selected. */
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  readonly disabled?: boolean;
}

function toLocalDateTimeInputValue(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Strip seconds; datetime-local expects YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInputValue(local: string): string | null {
  if (local === '') return null;
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Compute the minimum acceptable datetime-local value: now + 5 minutes.
 * Prevents members from picking past dates that the server would reject.
 */
function minLocalDateTime(): string {
  const future = new Date(Date.now() + 5 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
}

export function SchedulePicker({
  value,
  onChange,
  disabled = false,
}: SchedulePickerProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const locale = useLocale();

  const localValue = useMemo(() => toLocalDateTimeInputValue(value), [value]);

  const previewText = useMemo(() => {
    if (value === null) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const formatter =
      locale === 'th'
        ? new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
            dateStyle: 'long',
            timeStyle: 'short',
          })
        : new Intl.DateTimeFormat(locale, {
            dateStyle: 'long',
            timeStyle: 'short',
          });
    return formatter.format(date);
  }, [value, locale]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id="schedule-immediate"
          checked={value === null}
          onCheckedChange={(checked: boolean | 'indeterminate') => {
            if (checked === true) {
              onChange(null);
            } else {
              // Default to "in 1 hour"
              const future = new Date(Date.now() + 60 * 60 * 1000);
              onChange(future.toISOString());
            }
          }}
          disabled={disabled}
        />
        <Label htmlFor="schedule-immediate" className="cursor-pointer">
          {t('scheduleHelp')}
        </Label>
      </div>
      {value !== null ? (
        <div className="space-y-1">
          <Label htmlFor="schedule-when">{t('schedulePicker')}</Label>
          <Input
            id="schedule-when"
            type="datetime-local"
            value={localValue}
            min={minLocalDateTime()}
            onChange={(e) =>
              onChange(fromLocalDateTimeInputValue(e.target.value))
            }
            disabled={disabled}
            aria-describedby="schedule-when-preview"
          />
          {previewText !== '' ? (
            <p
              id="schedule-when-preview"
              className="text-xs text-muted-foreground"
              aria-live="polite"
            >
              {previewText}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
