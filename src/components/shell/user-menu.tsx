'use client';

/**
 * UserMenu — avatar / name / role badge / sign-out (T074, ux-standards § 8.1).
 *
 * Always-visible header element on every authenticated page. Clicking
 * opens a shadcn dropdown with account settings + sign-out actions.
 * Sign-out is an HTML form posting to `/api/auth/sign-out` so it works
 * without JS (progressive enhancement).
 *
 * Members get an Account hub with section-anchor links (/portal/account,
 * #renewal-prefs, #data-privacy), theme controls, and sign-out (057).
 * Staff (admin/manager) keep the original single account item.
 */
import {
  LogOutIcon,
  UserIcon,
  CalendarClockIcon,
  ShieldIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
// Client component — same rationale as `idle-warning-dialog.tsx`.
// Type-only import of a Domain type is pure and safe.

import type { Role } from '@/modules/auth/domain/role';

export interface UserMenuProps {
  readonly displayName: string | null;
  readonly email: string;
  readonly role: Role;
}

const roleBadgeVariant: Record<Role, 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  manager: 'secondary',
  member: 'outline',
};

function initials(displayName: string | null, email: string): string {
  const source = displayName?.trim() || email;
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

export function UserMenu({ displayName, email, role }: UserMenuProps) {
  const t = useTranslations('shell.userMenu');
  const tBadge = useTranslations('shell.roleBadge');
  const tTheme = useTranslations('shell.theme');
  const tHub = useTranslations('portal.account.menu');
  const { setTheme } = useTheme();
  const isMember = role === 'member';
  const router = useRouter();

  const handleSignOut = async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        router.push(role === 'member' ? '/portal/sign-in' : '/admin/sign-in');
        router.refresh();
      } else {
        toast.error(t('signOutFailed'));
      }
    } catch {
      toast.error(t('signOutNetworkError'));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('label')} />}>
        <Avatar className="size-8">
          <AvatarFallback>{initials(displayName, email)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* Base UI requires <DropdownMenuLabel> to live inside a
            <DropdownMenuGroup>, so we wrap each section in its own
            group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{displayName ?? email}</span>
              <span className="text-xs text-muted-foreground">{email}</span>
              <Badge variant={roleBadgeVariant[role]} className="mt-1 w-fit">
                {tBadge(role)}
              </Badge>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {isMember ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href="/portal/account" />}>
                <UserIcon className="size-4" aria-hidden />
                {t('account')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/portal/account#renewal-prefs" />}>
                <CalendarClockIcon className="size-4" aria-hidden />
                {tHub('renewalPrefs')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/portal/account#data-privacy" />}>
                <ShieldIcon className="size-4" aria-hidden />
                {tHub('dataPrivacy')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('light')}>
                <SunIcon className="size-4" aria-hidden />
                {tTheme('light')}
              </DropdownMenuItem>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('dark')}>
                <MoonIcon className="size-4" aria-hidden />
                {tTheme('dark')}
              </DropdownMenuItem>
              <DropdownMenuItem closeOnClick={false} onClick={() => setTheme('system')}>
                <MonitorIcon className="size-4" aria-hidden />
                {tTheme('system')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => router.push('/admin/account')}>
              <UserIcon className="size-4" aria-hidden />
              {t('account')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={handleSignOut}>
            <LogOutIcon className="size-4" aria-hidden />
            {t('signOut')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
