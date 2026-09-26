'use client';

/**
 * ThemeToggle — light/dark/system mode switcher (T047, ux-standards § 1.7).
 *
 * next-themes stays the source of truth (the `.dark` class, which AURA's
 * tokens also follow); spec 122 draws it as the `topbar()` boards do: an AURA
 * `IconButton` opening an AURA `DropdownMenu` of Light, Dark and System.
 * Theme defaults to `system` so the OS preference is honoured on first visit.
 */
import { MoonIcon, SunIcon, MonitorIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { DropdownMenu, IconButton } from '@jirawatpyk/aura-react';

export function ThemeToggle({ className }: { readonly className?: string } = {}) {
  const { setTheme } = useTheme();
  const t = useTranslations('shell.theme');

  return (
    <DropdownMenu
      label={t('label')}
      trigger={
        <IconButton
          label={t('label')}
          size="md"
          {...(className ? { className } : {})}
          // Sun in light, moon in dark — by CSS, so the server's HTML is right
          // before next-themes knows the resolved theme (no hydration flip).
          icon={
            <>
              <SunIcon className="size-full dark:hidden" aria-hidden />
              <MoonIcon className="hidden size-full dark:block" aria-hidden />
            </>
          }
        />
      }
      items={[
        { label: t('light'), icon: <SunIcon aria-hidden />, onSelect: () => setTheme('light') },
        { label: t('dark'), icon: <MoonIcon aria-hidden />, onSelect: () => setTheme('dark') },
        { label: t('system'), icon: <MonitorIcon aria-hidden />, onSelect: () => setTheme('system') },
      ]}
    />
  );
}
