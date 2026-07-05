'use client';

/**
 * PortalSignOutButton — Sign-out affordance folded into the Account-hub
 * "Account" card (023 option B: the standalone theme/sign-out card was removed
 * — its theme toggle duplicated the header ThemeToggle + UserMenu theme
 * items). The mobile Account tab opens /portal/account directly, so keeping a
 * sign-out here backs up the header UserMenu on small screens. Same POST +
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
    // min-h-11 = 44px tap target — member-portal CTAs are ≥44px
    // (ux-standards § 9.1, WCAG 2.5.5 AAA on mobile).
    <Button variant="outline" className="min-h-11" onClick={handleSignOut}>
      <LogOutIcon className="size-4" aria-hidden />
      {t('signOut')}
    </Button>
  );
}
