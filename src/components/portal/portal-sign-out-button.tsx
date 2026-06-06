'use client';

/**
 * PortalSignOutButton — Sign-out affordance for the Account-hub Appearance
 * section. On mobile the Account tab opens /portal/account directly (no avatar
 * dropdown per spec §2), so the hub needs its own sign-out. Same POST +
 * router-push + toast pattern as <UserMenu>.
 */
import { LogOutIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function PortalSignOutButton() {
  const t = useTranslations('shell.userMenu');
  const router = useRouter();

  const handleSignOut = async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        router.push('/portal/sign-in');
        router.refresh();
      } else {
        toast.error(t('signOutFailed'));
      }
    } catch {
      toast.error(t('signOutNetworkError'));
    }
  };

  return (
    <Button variant="outline" className="min-h-11" onClick={handleSignOut}>
      <LogOutIcon className="size-4" aria-hidden />
      {t('signOut')}
    </Button>
  );
}
