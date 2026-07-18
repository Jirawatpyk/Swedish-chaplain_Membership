/**
 * Task 6 — "Document notes" settings section (WHT footer note,
 * statutory termination notice).
 *
 * Mechanical extraction from `invoice-settings-form.tsx`'s
 * Withholding-tax-note + Termination-notice fieldsets (unchanged).
 * Field JSX moved verbatim; only the `useState` reads/writes became
 * props.
 *
 * I2 (wave B, settings-ux-invoice-reminders) — the `auto_email_enabled`
 * switch that used to live here (a standalone bordered `<div>` after
 * these two fieldsets) has been RELOCATED to `numbering-section.tsx`'s
 * "Defaults" fieldset area — it's a send-behaviour default, not a note.
 * Same id/aria-label/binding at its new home; nothing about the control
 * itself changed, only which section renders it.
 *
 * Section id is `"notes"` (not `"document-notes"`) — see task-6-brief.
 *
 * Controlled + presentational only: no local field state, no PATCH,
 * no validation logic.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const WHT_MAX = 500;
// 065 §5.4 — statutory termination notice length cap (mirrors the route zod).
const TERMINATION_NOTICE_MAX = 500;

export interface DocumentNotesSectionProps {
  readonly whtNoteTh: string;
  readonly onWhtNoteThChange: (value: string) => void;
  readonly whtNoteEn: string;
  readonly onWhtNoteEnChange: (value: string) => void;
  readonly terminationNoticeTh: string;
  readonly onTerminationNoticeThChange: (value: string) => void;
  readonly terminationNoticeEn: string;
  readonly onTerminationNoticeEnChange: (value: string) => void;
  readonly disabled: boolean;
}

export function DocumentNotesSection({
  whtNoteTh,
  onWhtNoteThChange,
  whtNoteEn,
  onWhtNoteEnChange,
  terminationNoticeTh,
  onTerminationNoticeThChange,
  terminationNoticeEn,
  onTerminationNoticeEnChange,
  disabled,
}: DocumentNotesSectionProps) {
  const t = useTranslations('admin.invoiceSettings');

  return (
    <section
      id="notes"
      aria-labelledby="notes-heading"
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <h2
        id="notes-heading"
        data-section-heading
        tabIndex={-1}
        className="font-heading text-base font-semibold"
      >
        {t('sections.documentNotes')}
      </h2>

      {/* 088 US5 — Withholding-tax footer note (membership documents only) */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.whtNote')}</legend>
        <p className="text-xs text-muted-foreground">{t('hints.whtNote')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="wht_th">{t('labels.whtNoteTh')}</Label>
            <Textarea
              id="wht_th"
              value={whtNoteTh}
              onChange={(e) => onWhtNoteThChange(e.target.value)}
              disabled={disabled}
              maxLength={WHT_MAX}
              rows={3}
              lang="th"
              // 088 US5 — RD-validated suggested wording (membership dues are
              // WHT-exempt, §65 bis (13) / ruling กค 0811/8542). Placeholder, not
              // a forced value: the admin still opts in per tenant.
              placeholder={t('hints.whtNoteThExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: whtNoteTh.length, max: WHT_MAX })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wht_en">{t('labels.whtNoteEn')}</Label>
            <Textarea
              id="wht_en"
              value={whtNoteEn}
              onChange={(e) => onWhtNoteEnChange(e.target.value)}
              disabled={disabled}
              maxLength={WHT_MAX}
              rows={3}
              placeholder={t('hints.whtNoteEnExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: whtNoteEn.length, max: WHT_MAX })}
            </p>
          </div>
        </div>
      </fieldset>

      {/* 065 §5.4 — Statutory termination notice (ใบแจ้งหนี้ / bill only) */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">{t('sections.terminationNotice')}</legend>
        <p className="text-xs text-muted-foreground">{t('hints.terminationNotice')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="termination_notice_th">{t('labels.terminationNoticeTh')}</Label>
            <Textarea
              id="termination_notice_th"
              value={terminationNoticeTh}
              onChange={(e) => onTerminationNoticeThChange(e.target.value)}
              disabled={disabled}
              maxLength={TERMINATION_NOTICE_MAX}
              rows={3}
              lang="th"
              placeholder={t('hints.terminationNoticeThExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: terminationNoticeTh.length, max: TERMINATION_NOTICE_MAX })}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="termination_notice_en">{t('labels.terminationNoticeEn')}</Label>
            <Textarea
              id="termination_notice_en"
              value={terminationNoticeEn}
              onChange={(e) => onTerminationNoticeEnChange(e.target.value)}
              disabled={disabled}
              maxLength={TERMINATION_NOTICE_MAX}
              rows={3}
              placeholder={t('hints.terminationNoticeEnExample')}
            />
            <p className="text-right text-xs text-muted-foreground">
              {t('charCount', { count: terminationNoticeEn.length, max: TERMINATION_NOTICE_MAX })}
            </p>
          </div>
        </div>
      </fieldset>
    </section>
  );
}
