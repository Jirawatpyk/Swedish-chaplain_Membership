'use client';

/**
 * UserMenu — avatar / name / role badge / sign-out (T074, ux-standards § 8.1).
 *
 * Always-visible header element on every authenticated page. Spec 122 draws
 * it as the `topbar()` boards do — avatar + name (name hidden below 1024px) +
 * chevron — opening an AURA `DropdownMenu`: who is signed in (name, role and
 * email in the menu's `header`, outside the items and read as the menu's
 * description), then the account links and sign-out.
 * Sign-out is a client-side `fetch('/api/auth/sign-out', { method: 'POST' })`
 * (this is a `'use client'` component); on success it routes to the
 * role-appropriate sign-in page via `router.push` + `router.refresh`, and on
 * failure/network error it shows a toast. It requires JS (no progressive
 * enhancement) — consistent with the rest of this interactive dropdown.
 *
 * Members get an Account menu linking to Account settings (/portal/account)
 * and its in-page sections (Renewal preferences → /portal/account#renewal-prefs,
 * Data & privacy → /portal/account#data-privacy) and sign-out. Theme controls
 * live only on the top bar (<ThemeToggle>), not duplicated in this dropdown.
 * D2 consolidated these into the single Account hub; the legacy routes
 * (/portal/preferences/renewals, /portal/account/data-export) now redirect to
 * the matching anchors, so renewal-reminder email CTAs keep resolving.
 * Staff (admin/manager) keep the original single account item.
 */
import { ChevronDownIcon, LogOutIcon, UserIcon, CalendarClockIcon, ShieldIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Avatar, DropdownMenu, useBreakpoint, type MenuItem } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

import type { Role } from '@/modules/auth/domain/role';

export interface UserMenuProps {
  readonly displayName: string | null;
  readonly email: string;
  readonly role: Role;
  /**
   * Spec 122 — on a phone the staff top bar has no room for the colour-scheme
   * button (the `Admin-members-mobile` board drops it), so the choice moves
   * into this menu below 640px. The member portal keeps its own button.
   */
  readonly themeChoicesOnPhone?: boolean;
}

export function UserMenu({ displayName, email, role, themeChoicesOnPhone = false }: UserMenuProps) {
  const t = useTranslations('shell.userMenu');
  const tBadge = useTranslations('shell.roleBadge');
  const tHub = useTranslations('portal.account.menu');
  // rbac-portal-identity-ok: chooses the member-portal menu items over the
  // staff ones; grants nothing either way.
  const isMember = role === 'member';
  const router = useRouter();
  const tTheme = useTranslations('shell.theme');
  const { theme, setTheme } = useTheme();
  const onPhone = useBreakpoint() === 'base';

  const handleSignOut = async () => {
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST' });
      if (response.ok) {
        // rbac-portal-identity-ok: picks which sign-in screen to return to.
        router.push(role === 'member' ? '/portal/sign-in' : '/admin/sign-in');
        router.refresh();
      } else {
        toast.error(t('signOutFailed'));
      }
    } catch {
      toast.error(t('signOutNetworkError'));
    }
  };

  const name = displayName?.trim() || email;
  const header = (
    <>
      <p>
        <strong>{name}</strong> · {tBadge(role)}
      </p>
      {name === email ? null : <p>{email}</p>}
    </>
  );
  const links: MenuItem[] = isMember
    ? [
        { label: t('account'), icon: <UserIcon aria-hidden />, href: '/portal/account' },
        { label: tHub('renewalPrefs'), icon: <CalendarClockIcon aria-hidden />, href: '/portal/account#renewal-prefs' },
        { label: tHub('dataPrivacy'), icon: <ShieldIcon aria-hidden />, href: '/portal/account#data-privacy' },
      ]
    : [{ label: t('account'), icon: <UserIcon aria-hidden />, onSelect: () => router.push('/admin/account') }];

  const themeChoices: MenuItem[] =
    themeChoicesOnPhone && onPhone
      ? [
          { separator: true },
          ...(['light', 'dark', 'system'] as const).map((value) => ({
            type: 'radio' as const,
            group: tTheme('label'),
            label: tTheme(value),
            checked: theme === value,
            onSelect: () => setTheme(value),
          })),
        ]
      : [];

  return (
    <DropdownMenu
      label={t('label')}
      trigger={
        <button
          type="button"
          className={cn(
            'inline-flex h-10 items-center justify-center gap-2 rounded-full py-0 pr-2.5 pl-1 text-[13px] font-medium text-[var(--aura-fg-primary)] hover:bg-[var(--aura-bg-surface-hover)] pointer-coarse:h-11 pointer-coarse:min-w-11',
            AURA_FOCUS_RING,
          )}
        >
          {/* The name is "Account menu" + the visible name (WCAG 2.5.3). The
              avatar's initials repeat the name, so it stays out of it. */}
          <span className="sr-only">{t('label')}</span>
          <span aria-hidden className="contents">
            <Avatar name={name} size="sm" />
          </span>
          <span className="hidden max-w-40 truncate lg:inline">{name}</span>
          <ChevronDownIcon className="size-4 max-sm:hidden" aria-hidden />
        </button>
      }
      header={header}
      items={[
        ...links,
        ...themeChoices,
        { separator: true },
        { label: t('signOut'), icon: <LogOutIcon aria-hidden />, onSelect: () => void handleSignOut() },
      ]}
    />
  );
}
