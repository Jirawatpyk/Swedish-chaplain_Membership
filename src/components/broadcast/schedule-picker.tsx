'use client';

/**
 * T087 — Schedule picker (optional future-send).
 *
 * Single `<input type="datetime-local">` paired with a "Send for review
 * immediately" checkbox. When checked, the input is disabled and value
 * cleared. All wall-time conversion uses **Bangkok wall-time** (not
 * browser-local) so the system matches the microcopy promise and the
 * admin approve dialog (F7 UX hardening E2). Preview formatter pins
 * `timeZone: 'Asia/Bangkok'`.
 *
 * Schedule lead-time uses Bangkok now + 5 min as the min value (matches
 * server-side NFR-PERF-002).
 */
import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  bangkokInputToIso,
  isoToBangkokInput,
  bangkokMinInputAfterMinutes,
} from './bangkok-datetime';

export interface SchedulePickerProps {
  /** ISO-8601 UTC string or null when "send immediately" is selected. */
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  readonly disabled?: boolean;
}

export function SchedulePicker({
  value,
  onChange,
  disabled = false,
}: SchedulePickerProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const locale = useLocale();

  const localValue = useMemo(() => isoToBangkokInput(value), [value]);

  const previewText = useMemo(() => {
    if (value === null) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    // Pin formatter to Asia/Bangkok so the displayed wall-time matches
    // the contract the picker asks the user to provide (E2 UX hardening
    // — previously this defaulted to the BROWSER local TZ, so an admin
    // travelling abroad would see a different time than they typed).
    const formatter =
      locale === 'th'
        ? new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Asia/Bangkok',
          })
        : new Intl.DateTimeFormat(locale, {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Asia/Bangkok',
          });
    return formatter.format(date);
  }, [value, locale]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id="schedule-immediate"
          // base-ui Checkbox.Root renders its own internal id, so the
          // sibling <Label htmlFor> can't name it — set the accessible
          // name directly (fixes axe aria-toggle-field-name).
          aria-label={t('scheduleHelp')}
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
            min={bangkokMinInputAfterMinutes(5)}
            onChange={(e) =>
              onChange(bangkokInputToIso(e.target.value))
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
