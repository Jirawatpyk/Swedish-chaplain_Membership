'use client';

/**
 * FR-030 — copy-to-clipboard button on member_id, email, tax_id.
 *
 * Uses the Clipboard API with a graceful fallback (selecting the text in a
 * hidden textarea) for older browsers. Fires a sonner toast on success so
 * the action lands with feedback (ux-standards § 4.2).
 */

import { useTranslations } from 'next-intl';
import { CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

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
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      aria-label={label}
      className="h-7 px-2"
    >
      <CopyIcon className="size-3.5" aria-hidden />
    </Button>
  );
}
