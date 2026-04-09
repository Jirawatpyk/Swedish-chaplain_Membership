'use client';

/**
 * UserMenu — avatar / name / role badge / sign-out (T074, ux-standards § 8.1).
 *
 * Always-visible header element on every authenticated page. Clicking
 * opens a shadcn dropdown with account settings + sign-out actions.
 * Sign-out is an HTML form posting to `/api/auth/sign-out` so it works
 * without JS (progressive enhancement).
 */
import { LogOutIcon, UserIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const router = useRouter();

  const handleSignOut = async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        router.push(role === 'member' ? '/portal/sign-in' : '/admin/sign-in');
        router.refresh();
      } else {
        toast.error('Sign out failed');
      }
    } catch {
      toast.error('Network error during sign out');
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
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => router.push(role === 'member' ? '/portal/account' : '/admin/account')}
          >
            <UserIcon className="size-4" aria-hidden />
            {t('account')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
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
