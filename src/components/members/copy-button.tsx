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
  // P6 round-10 ui-design-specialist — bumped from h-7 (28px) to h-9
  // (36px) to match the F4-era button standard documented in
  // docs/ux-standards.md § 5. CopyButton sits inline next to copy-
  // anchor text (member_id, email, tax_id) and was the only sub-36px
  // affordance in the F3 detail header. The icon stays 14px (size-3.5)
  // so the visual weight remains modest; the touch target grows.
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      aria-label={label}
      className="h-9 px-2"
    >
      <CopyIcon className="size-3.5" aria-hidden />
    </Button>
  );
}
