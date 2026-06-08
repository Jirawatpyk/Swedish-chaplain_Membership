'use client';

/**
 * ThemeToggle — light/dark/system mode switcher (T047, ux-standards § 1.7).
 *
 * Wraps next-themes with a shadcn DropdownMenu so the user can pick
 * Light, Dark, or System. Theme defaults to `system` so the OS
 * preference is honoured on first visit.
 *
 * `size` defaults to `icon` (32px) for the compact header/auth-page usage
 * (app-shell icon-trigger convention, ux-standards § 19). The Account-hub
 * Appearance row passes `className="size-11"` to force a 44×44 tap target —
 * member-portal CTAs are ≥44px (ux-standards § 9.1, WCAG 2.5.5 AAA on
 * mobile). `className` is cn'd LAST so a `size-*` override wins over the
 * `size` variant via tailwind-merge.
 */
import { MoonIcon, SunIcon, MonitorIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ThemeToggle({
  size = 'icon',
  className,
}: {
  readonly size?: 'icon' | 'icon-lg';
  readonly className?: string;
} = {}) {
  const { setTheme } = useTheme();
  const t = useTranslations('shell.theme');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={t('label')}
            className={cn(className)}
          />
        }
      >
        <SunIcon className="size-4 dark:hidden" aria-hidden />
        <MoonIcon className="hidden size-4 dark:block" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <SunIcon className="size-4" aria-hidden /> {t('light')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <MoonIcon className="size-4" aria-hidden /> {t('dark')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <MonitorIcon className="size-4" aria-hidden /> {t('system')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
