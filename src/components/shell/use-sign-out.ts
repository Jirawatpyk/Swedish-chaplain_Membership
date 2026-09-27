'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';

/**
 * Sign-out as the account menu does it, shared with the staff phone drawer's
 * "Sign out" row (spec 122, `Admin-nav-mobile`): POST the sign-out route,
 * then go to the portal's sign-in page; a toast on failure.
 */
export function useSignOut(portal: 'member' | 'staff'): () => Promise<void> {
  const t = useTranslations('shell.userMenu');
  const router = useRouter();
  return async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        router.push(portal === 'member' ? '/portal/sign-in' : '/admin/sign-in');
        router.refresh();
      } else {
        toast.error(t('signOutFailed'));
      }
    } catch {
      toast.error(t('signOutNetworkError'));
    }
  };
}
