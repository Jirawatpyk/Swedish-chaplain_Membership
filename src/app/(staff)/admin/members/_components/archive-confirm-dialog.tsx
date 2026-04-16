'use client';

/**
 * T110 — Archive confirmation dialog with typed-phrase confirmation (US4 AS3).
 *
 * When > 5 rows are selected, the admin must type the exact phrase
 * "Archive N members" to confirm the destructive action per
 * ux-standards § 4 destructive-action rules.
 *
 * Lists up to 5 company names; truncates the rest with "…and N more".
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

const TYPED_PHRASE_THRESHOLD = 5;

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly companyNames: string[];
  readonly count: number;
  readonly onConfirm: () => void;
};

export function ArchiveConfirmDialog({
  open,
  onOpenChange,
  companyNames,
  count,
  onConfirm,
}: Props) {
  const t = useTranslations('admin.members.bulk');
  const [typedPhrase, setTypedPhrase] = useState('');
  const requiresPhrase = count > TYPED_PHRASE_THRESHOLD;
  const expectedPhrase = t('archivePhrase', { count });

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) setTypedPhrase('');
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const canConfirm = requiresPhrase
    ? typedPhrase.trim() === expectedPhrase
    : true;

  const displayedNames = companyNames.slice(0, 5);
  const remainingCount = count - displayedNames.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('archiveTitle', { count })}</DialogTitle>
          <DialogDescription>
            {t('archiveDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Company name list */}
          <ul className="list-disc pl-5 text-sm" aria-label={t('affectedMembers')}>
            {displayedNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
            {remainingCount > 0 && (
              <li className="text-muted-foreground">
                {t('andMore', { count: remainingCount })}
              </li>
            )}
          </ul>

          {/* Typed-phrase confirmation for > 5 rows */}
          {requiresPhrase && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="archive-confirm-phrase">
                {t('typeToConfirm', { phrase: expectedPhrase })}
              </Label>
              <Input
                id="archive-confirm-phrase"
                type="text"
                value={typedPhrase}
                onChange={(e) => setTypedPhrase(e.target.value)}
                placeholder={expectedPhrase}
                autoComplete="off"
                autoFocus
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={onConfirm}
            className="min-h-[36px]"
          >
            {t('confirmArchive', { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
