'use client';

/**
 * FR-030 — copy-to-clipboard button on member_id, email, tax_id.
 *
 * Uses the Clipboard API with a graceful fallback (selecting the text in a
 * hidden textarea) for older browsers. Fires a toast on success so
 * the action lands with feedback (ux-standards § 4.2).
 */

import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { IconButton } from '@jirawatpyk/aura-react';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations('admin.members.detail.copy');
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('copied'));
    } catch {
      // Fallback path — older browsers + insecure contexts
      const el = document.createElement('textarea');
      el.value = value;
      el.setAttribute('readonly', '');
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
        toast.success(t('copied'));
      } finally {
        document.body.removeChild(el);
      }
    }
  };
  // Spec 122 US3: AURA IconButton — a 32px round button whose hit area is
  // 44px on touch screens, with the label as its accessible name and tooltip.
  return <IconButton icon="copy" label={label} onClick={onCopy} />;
}
