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
 *
 * Spec 122 US8c-2 (T856) — an AURA card (board `Admin-invoice-settings`),
 * the rail's focus target, with its fieldsets inside and AURA fields; ids,
 * labels, limits and character counters (now each field's hint) unchanged.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Card, Textarea } from '@jirawatpyk/aura-react';

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
    <Card
      as="section"
      id="notes"
      tabIndex={-1}
      className="scroll-mt-24 focus-visible:outline-none"
      title={t('sections.documentNotes')}
      titleId="notes-heading"
      headingLevel={2}
    >
      <div className="flex flex-col gap-[var(--aura-space-6)]">
        {/* 088 US5 — Withholding-tax footer note (membership documents only) */}
        <fieldset className="flex flex-col gap-[var(--aura-space-3)]">
          <legend className="mb-[var(--aura-space-1)] text-sm font-semibold">{t('sections.whtNote')}</legend>
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('hints.whtNote')}</p>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
            <Textarea
              id="wht_th"
              label={t('labels.whtNoteTh')}
              hint={t('charCount', { count: whtNoteTh.length, max: WHT_MAX })}
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
            <Textarea
              id="wht_en"
              label={t('labels.whtNoteEn')}
              hint={t('charCount', { count: whtNoteEn.length, max: WHT_MAX })}
              value={whtNoteEn}
              onChange={(e) => onWhtNoteEnChange(e.target.value)}
              disabled={disabled}
              maxLength={WHT_MAX}
              rows={3}
              placeholder={t('hints.whtNoteEnExample')}
            />
          </div>
        </fieldset>

        {/* 065 §5.4 — Statutory termination notice (ใบแจ้งหนี้ / bill only) */}
        <fieldset className="flex flex-col gap-[var(--aura-space-3)]">
          <legend className="mb-[var(--aura-space-1)] text-sm font-semibold">{t('sections.terminationNotice')}</legend>
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('hints.terminationNotice')}</p>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2">
            <Textarea
              id="termination_notice_th"
              label={t('labels.terminationNoticeTh')}
              hint={t('charCount', { count: terminationNoticeTh.length, max: TERMINATION_NOTICE_MAX })}
              value={terminationNoticeTh}
              onChange={(e) => onTerminationNoticeThChange(e.target.value)}
              disabled={disabled}
              maxLength={TERMINATION_NOTICE_MAX}
              rows={3}
              lang="th"
              placeholder={t('hints.terminationNoticeThExample')}
            />
            <Textarea
              id="termination_notice_en"
              label={t('labels.terminationNoticeEn')}
              hint={t('charCount', { count: terminationNoticeEn.length, max: TERMINATION_NOTICE_MAX })}
              value={terminationNoticeEn}
              onChange={(e) => onTerminationNoticeEnChange(e.target.value)}
              disabled={disabled}
              maxLength={TERMINATION_NOTICE_MAX}
              rows={3}
              placeholder={t('hints.terminationNoticeEnExample')}
            />
          </div>
        </fieldset>
      </div>
    </Card>
  );
}
