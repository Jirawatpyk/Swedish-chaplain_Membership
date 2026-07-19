'use client';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function StickySaveBar({
  visible, submitting, onSave,
}: { readonly visible: boolean; readonly submitting: boolean; readonly onSave: () => void }) {
  const t = useTranslations('admin.invoiceSettings');
  if (!visible) return null;
  return (
    <div
      role="region"
      aria-label={t('stickyBar.label')}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur motion-safe:animate-in motion-safe:slide-in-from-bottom"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* I6 (wave B) — same width token as DetailContainer (the shell this
          bar sits over) instead of a magic-number copy, so the two stay
          aligned if the token ever changes. */}
      <div className="mx-auto flex max-w-[var(--layout-max-width-detail)] items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm text-muted-foreground">{t('stickyBar.unsaved')}</span>
        <Button type="button" onClick={onSave} disabled={submitting} aria-busy={submitting} className="min-h-11">
          {submitting && <Loader2Icon aria-hidden className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
          {t('actions.save')}
        </Button>
      </div>
    </div>
  );
}
