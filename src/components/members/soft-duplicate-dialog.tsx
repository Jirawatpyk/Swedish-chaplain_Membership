'use client';

/**
 * T055 — Soft-duplicate dialog (FR-031).
 *
 * Shown when the API returns 409 `soft_duplicate`. Offers three paths:
 *   - Proceed anyway (re-submits with `confirm_soft_duplicate: true`)
 *   - Open existing member (new tab so the draft form is preserved)
 *   - Cancel (closes the dialog; admin keeps editing the draft)
 *
 * Spec 122 US5b-2 (T578): AURA `Dialog` (no board — AURA defaults, content and
 * behaviour unchanged).
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLinkIcon } from 'lucide-react';
import { Button, Dialog } from '@jirawatpyk/aura-react';

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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={onProceed}>{t('proceed')}</Button>
        </>
      }
    >
      {existing && (
        <div className="flex flex-col items-start gap-1 rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-canvas)] p-3 text-sm">
          <div className="text-xs text-[var(--aura-fg-secondary)]">{t('existingLabel')}</div>
          <div className="font-medium text-[var(--aura-fg-primary)]">{existing.company_name}</div>
          <Link
            href={`/admin/members/${existing.member_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 text-[var(--aura-fg-accent)] underline-offset-2 hover:underline"
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            {t('openExisting')}
          </Link>
        </div>
      )}
    </Dialog>
  );
}
