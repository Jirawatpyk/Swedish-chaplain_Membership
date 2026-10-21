'use client';

/**
 * T054 — Override-reason dialog (FR-006a).
 *
 * Shown when a validation warning fires (turnover outside band, age over
 * limit, startup too old). Records the admin's reason for proceeding —
 * lands in the audit log via the create-member use case.
 *
 * "Other" requires a note (Domain invariant enforced by
 * `asOverrideReason`); the dialog's Proceed button is disabled until the
 * note is present.
 *
 * Spec 122 US5b-2 (T578): AURA `Dialog` with an AURA Select and Textarea (no
 * board — AURA defaults; ids `override_code` / `override_note` kept). A stray
 * scrim click never throws away a typed reason.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Dialog, Select, Textarea } from '@jirawatpyk/aura-react';

// Inlined intentionally — importing from `@/modules/members` (barrel)
// pulls transitive drizzle/postgres deps into the client bundle via
// `directorySearch → searchDirectory (infrastructure/db/drizzle-member-repo)`.
// This constant is pure data; keeping it in sync with the Domain file
// is cheap. If the Domain enum changes, the unit test in
// `tests/unit/members/domain/override-reason.test.ts` stays authoritative.
const OVERRIDE_REASON_CODES = [
  'board_approved',
  'pending_renewal_grace',
  'data_correction',
  'other',
] as const;

export type OverrideReasonResult = {
  readonly code: (typeof OVERRIDE_REASON_CODES)[number];
  readonly note: string | null;
};

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Localised reason for the warning (e.g. "Turnover 500,000 is below plan min 1,000,000"). */
  readonly warningMessage: string | null;
  readonly onConfirm: (result: OverrideReasonResult) => void;
};

export function OverrideReasonDialog({
  open,
  onOpenChange,
  warningMessage,
  onConfirm,
}: Props) {
  const t = useTranslations('admin.members.overrideReason');
  const [code, setCode] = useState<
    (typeof OVERRIDE_REASON_CODES)[number] | null
  >(null);
  const [note, setNote] = useState('');
  // The note's "required" error waits until the note has been left empty
  // (never on picking "Other" before anything is typed).
  const [noteTouched, setNoteTouched] = useState(false);

  const noteRequired = code === 'other';
  const canProceed =
    code !== null && (!noteRequired || note.trim().length > 0);

  const handleProceed = () => {
    if (!canProceed || code === null) return;
    onConfirm({ code, note: note.trim() || null });
    setCode(null);
    setNote('');
    setNoteTouched(false);
  };

  const handleCancel = () => {
    setCode(null);
    setNote('');
    setNoteTouched(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onClose={handleCancel}
      dismissOnScrim={false}
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button onClick={handleProceed} disabled={!canProceed}>
            {t('proceed')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {warningMessage && (
          <Alert tone="warning" role="note">
            {warningMessage}
          </Alert>
        )}
        <Select
          id="override_code"
          label={t('codeLabel')}
          required
          value={code ?? ''}
          placeholder={t('codePlaceholder')}
          options={OVERRIDE_REASON_CODES.map((c) => ({ value: c, label: t(`codes.${c}`) }))}
          onChange={(e) => setCode(e.target.value as (typeof OVERRIDE_REASON_CODES)[number])}
        />
        <Textarea
          id="override_note"
          label={t('noteLabel')}
          required={noteRequired}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => setNoteTouched(true)}
          maxLength={500}
          rows={3}
          placeholder={t('notePlaceholder')}
          error={noteTouched && noteRequired && note.trim() === '' ? t('noteRequired') : undefined}
        />
      </div>
    </Dialog>
  );
}
