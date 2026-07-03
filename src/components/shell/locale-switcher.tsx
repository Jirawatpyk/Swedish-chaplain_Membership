'use client';

/**
 * LocaleSwitcher — EN/TH/SV interface-language switcher (ux-standards § 19).
 *
 * Cookie-only: writes the `NEXT_LOCALE` cookie (`LOCALE_COOKIE_NAME`) then
 * `router.refresh()` so the RSC tree re-reads it via `getRequestConfig` — new
 * messages + Buddhist-Era date formats + `<html lang>` (set from `getLocale()`
 * in the root layout). Client-only, mirroring `ThemeToggle`. It does NOT touch
 * member `preferred_locale` (email language) — that stays an Account-settings
 * preference (see the design doc).
 *
 * The trigger shows the current-language endonym so it is legible to someone
 * who cannot read the current UI language (an icon-only tooltip would be in
 * that same unreadable language). An `sr-only` label makes the accessible name
 * "<action> <endonym>" — conveying purpose AND satisfying WCAG 2.5.3 (the
 * visible endonym is contained in the accessible name). The menu is a radio
 * group so the active locale is announced (`aria-checked`) to screen readers.
 */
import { LanguagesIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  LOCALE_COOKIE_NAME,
  isLocale,
  localeLabels,
  locales,
  type Locale,
} from '@/i18n/config';

export function LocaleSwitcher({
  className,
}: {
  readonly className?: string;
} = {}) {
  const t = useTranslations('shell.locale');
  const activeLocale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleValueChange = (value: string) => {
    // Ignore re-entrant selections while a refresh is still in flight:
    // `activeLocale` only updates after the RSC re-render resolves, so a
    // second pick would otherwise fire an overlapping `router.refresh()`.
    if (isPending || !isLocale(value) || value === activeLocale) return;
    // 1-year, path=/ so it applies to every route; SameSite=Lax is fine for a
    // non-sensitive UI-preference cookie. Synchronous — written before the
    // refresh request is sent, so the RSC pass reads the new value.
    document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-busy={isPending}
            // h-8 (32px) height-matches the neighbouring ThemeToggle/UserMenu
            // icon buttons (size="icon" = size-8); cn'd last so it wins over
            // the `sm` variant's h-7 via tailwind-merge.
            className={cn('h-8 gap-1.5', className)}
          />
        }
      >
        <LanguagesIcon className="size-4" aria-hidden />
        {/* sr-only action phrase + visible endonym → accessible name is
            "Change language English", which contains the visible label. */}
        <span className="sr-only">{t('label')}</span>
        <span className="text-sm font-medium">{localeLabels[activeLocale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={activeLocale} onValueChange={handleValueChange}>
          {locales.map((locale) => (
            // closeOnClick: Base UI RadioItem defaults to false (menu stays
            // open). Closing on select matches the expected switcher UX and
            // keeps the E2E round-trip robust (a re-open is a fresh open).
            <DropdownMenuRadioItem key={locale} value={locale} closeOnClick>
              {localeLabels[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
