'use client';

/**
 * The one message a member mutation shows when the READ_ONLY_MODE write
 * freeze refused it (`isReadOnlyRefusal` / `isReadOnlyResponse`).
 *
 * A WARNING, not an error: nothing is wrong with what the member did and
 * nothing failed that a retry now would fix. The description says the part
 * the member worries about — nothing changed — and when to come back.
 *
 * Returns the title so a caller that also announces through its own live
 * region (`DataExportPanel`, `PreferredLocaleForm`) says the same words.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';

export function useReadOnlyToast(): () => string {
  const t = useTranslations('errors');
  return useCallback(() => {
    const title = t('readOnlyMode');
    toast.warning(title, { description: t('readOnlyNothingChanged') });
    return title;
  }, [t]);
}
