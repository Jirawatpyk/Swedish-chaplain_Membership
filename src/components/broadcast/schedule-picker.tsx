'use client';

/**
 * T087 — Schedule picker (optional future-send).
 *
 * Spec 122 US12d-3 (T1266; the maintainer, 26 Oct 2026; board
 * `Proposal-compose-inset-send-options`): "Send options" — one collapsed line
 * that states the current choice ("As soon as it's approved", or the time),
 * expanding to one optional "Schedule for later" field. It replaces the old
 * "Leave blank to submit for immediate review" checkbox, whose words now sit
 * where they belong, as the field's hint: a blank field means now. The value
 * is unchanged — an ISO instant, or `null` for immediate review.
 *
 * All wall-time conversion uses **Bangkok wall-time** (not browser-local) so
 * the system matches the microcopy promise and the admin approve dialog (F7
 * UX hardening E2). Schedule lead-time uses Bangkok now + 5 min as the min
 * value (matches server-side NFR-PERF-002).
 */
import { useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { Button, TextField } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';
import {
  bangkokInputToIso,
  isoToBangkokInput,
  bangkokMinInputAfterMinutes,
  formatScheduledFor,
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
  const t = useTranslations('portal.broadcasts.compose');
  const locale = useLocale();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const localValue = useMemo(() => isoToBangkokInput(value), [value]);
  const scheduled = formatScheduledFor(value, locale);

  return (
    <div className="flex flex-col gap-2" data-compose-feature="schedule-picker">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="-ms-1 inline-flex min-h-11 items-center gap-1.5 self-start rounded-[var(--aura-radius-sm)] ps-1 pe-2 text-start text-sm font-medium text-[var(--aura-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)] disabled:opacity-[var(--aura-disabled-opacity)] sm:[@media(pointer:fine)]:min-h-9"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-4 shrink-0 motion-safe:transition-transform', open && 'rotate-90')}
        />
        <span>{t('fields.sendOptions')}</span>{' '}
        <span className="font-normal text-[var(--aura-fg-secondary)]">
          · {scheduled === '' ? t('confirm.sendingNow') : t('confirm.sendingAt', { when: scheduled })}
        </span>
      </button>
      <div id={panelId} hidden={!open} className="flex max-w-sm flex-col items-start gap-2 ps-6">
        <TextField
          label={t('fields.schedulePicker')}
          optional
          type="datetime-local"
          hint={t('fields.scheduleHelp')}
          value={localValue}
          min={bangkokMinInputAfterMinutes(5)}
          onChange={(e) => onChange(e.target.value === '' ? null : bangkokInputToIso(e.target.value))}
          disabled={disabled}
          touchHeight
        />
        {/* Review round 1 (UX): clearing a datetime field has no visible
            control in every browser; this puts "now" back in one press. */}
        {value !== null ? (
          <Button type="button" variant="ghost" size="sm" touchHeight onClick={() => onChange(null)} disabled={disabled}>
            {t('fields.scheduleClear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
