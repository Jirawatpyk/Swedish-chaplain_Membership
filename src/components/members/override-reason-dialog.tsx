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
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

  const noteRequired = code === 'other';
  const canProceed =
    code !== null && (!noteRequired || note.trim().length > 0);

  const handleProceed = () => {
    if (!canProceed || code === null) return;
    onConfirm({ code, note: note.trim() || null });
    setCode(null);
    setNote('');
  };

  const handleCancel = () => {
    setCode(null);
    setNote('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {warningMessage && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            {warningMessage}
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="override_code">{t('codeLabel')}</Label>
            <Select
              value={code ?? undefined}
              onValueChange={(v) =>
                setCode(v as (typeof OVERRIDE_REASON_CODES)[number])
              }
            >
              <SelectTrigger
                id="override_code"
                aria-required="true"
                className="w-full"
              >
                <SelectValue placeholder={t('codePlaceholder')}>
                  {(value: string | null) => {
                    if (
                      !value ||
                      !(OVERRIDE_REASON_CODES as readonly string[]).includes(
                        value,
                      )
                    ) {
                      return t('codePlaceholder');
                    }
                    return t(
                      `codes.${value}` as Parameters<typeof t>[0],
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OVERRIDE_REASON_CODES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`codes.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="override_note">
              {t('noteLabel')}
              {noteRequired && (
                <span aria-hidden className="ml-0.5 text-destructive">
                  *
                </span>
              )}
            </Label>
            <Textarea
              id="override_note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={t('notePlaceholder')}
              aria-required={noteRequired}
              aria-invalid={noteRequired && note.trim() === ''}
            />
            {noteRequired && note.trim() === '' && (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {t('noteRequired')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleProceed}
            disabled={!canProceed}
          >
            {t('proceed')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
