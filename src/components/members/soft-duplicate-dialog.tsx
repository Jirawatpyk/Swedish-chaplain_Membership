'use client';

/**
 * T055 — Soft-duplicate dialog (FR-031).
 *
 * Shown when the API returns 409 `soft_duplicate`. Offers three paths:
 *   - Proceed anyway (re-submits with `confirm_soft_duplicate: true`)
 *   - Open existing member (new tab so the draft form is preserved)
 *   - Cancel (closes the dialog; admin keeps editing the draft)
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLinkIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button, buttonVariants } from '@/components/ui/button';

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly existing: { readonly member_id: string; readonly company_name: string } | null;
  readonly onProceed: () => void;
};

export function SoftDuplicateDialog({
  open,
  onOpenChange,
  existing,
  onProceed,
}: Props) {
  const t = useTranslations('admin.members.softDuplicate');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {existing && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="text-xs text-muted-foreground">
              {t('existingLabel')}
            </div>
            <div className="font-medium">{existing.company_name}</div>
            <Link
              href={`/admin/members/${existing.member_id}`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'link', size: 'sm' })}
            >
              <ExternalLinkIcon className="size-3.5" />
              {t('openExisting')}
            </Link>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button type="button" onClick={onProceed}>
            {t('proceed')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
