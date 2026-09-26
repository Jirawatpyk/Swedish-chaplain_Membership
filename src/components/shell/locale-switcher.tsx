'use client';

/**
 * LocaleSwitcher — EN/TH/SV interface-language switcher (ux-standards § 19).
 *
 * Cookie-only: writes the `NEXT_LOCALE` cookie (`LOCALE_COOKIE_NAME`) then
 * `router.refresh()` so the RSC tree re-reads it via `getRequestConfig` — new
 * messages + Buddhist-Era date formats + `<html lang>` (set from `getLocale()`
 * in the root layout). Client-only, mirroring `ThemeToggle`. By default it is
 * cookie-only; when `persistToAccount` is set (member portal), it ALSO
 * best-effort persists the choice to `members.preferred_locale` (email
 * language) via `runPreferredLocalePersist`. Staff/auth stay cookie-only.
 *
 * The trigger shows the current language's code (EN / TH / SV, spec 122 —
 * the `topbar()` boards) so it is legible to someone who cannot read the
 * current UI language (an icon-only tooltip would be in that same unreadable
 * language). An `sr-only` label makes the accessible name "<action>
 * (<endonym>) <CODE>" — conveying purpose AND satisfying WCAG 2.5.3 (the
 * visible code is contained in the accessible name). The menu (AURA
 * `DropdownMenu`) lists the endonyms as radio items, so the active locale is
 * announced (`aria-checked`) to screen readers.
 */
import { ChevronDownIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useTransition } from 'react';
import { DropdownMenu } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { runAbortablePersist } from '@/components/shell/locale-persist';
import {
  LOCALE_COOKIE_NAME,
  isLocale,
  localeLabels,
  locales,
  type Locale,
} from '@/i18n/config';

function writeLocaleCookie(value: Locale): void {
  document.cookie = `${LOCALE_COOKIE_NAME}=${value}; path=/; max-age=31536000; samesite=lax`;
}

const PERSIST_TIMEOUT_MS = 8000;

export function LocaleSwitcher({
  className,
  persistToAccount = false,
}: {
  readonly className?: string;
  readonly persistToAccount?: boolean;
} = {}) {
  const t = useTranslations('shell.locale');
  const activeLocale = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const syncAbortRef = useRef<AbortController | null>(null);

  // Best-effort background write of preferred_locale for logged-in members.
  // Detached: never blocks the cookie-driven UI refresh. INVARIANT: no setState
  // / no toast here — only console.warn on a hard failure (a state update after
  // router.refresh() would be an orphaned-update bug). Abort-previous: a newer
  // pick supersedes an in-flight sync so a stale retry can't land out of order.
  const persistPreferredLocale = (locale: Locale): void => {
    runAbortablePersist(syncAbortRef, locale, PERSIST_TIMEOUT_MS, () => {
      console.warn('[LocaleSwitcher] preferred_locale sync failed');
    });
  };

  const handleValueChange = (value: string) => {
    // Ignore re-entrant selections while a refresh is still in flight:
    // `activeLocale` only updates after the RSC re-render resolves, so a
    // second pick would otherwise fire an overlapping `router.refresh()`.
    if (isPending || !isLocale(value) || value === activeLocale) return;
    // 1-year, path=/ so it applies to every route; SameSite=Lax is fine for a
    // non-sensitive UI-preference cookie. Synchronous — written before the
    // refresh request is sent, so the RSC pass reads the new value.
    writeLocaleCookie(value);
    if (persistToAccount) persistPreferredLocale(value); // value is Locale (isLocale guard above)
    startTransition(() => router.refresh());
  };

  return (
    <DropdownMenu
      label={t('label')}
      trigger={
        <button
          type="button"
          aria-busy={isPending}
          className={cn(
            // Spec 122 — the pill on the `topbar()` boards: the language CODE
            // (EN / TH / SV) is legible whatever the current UI language.
            'inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--aura-border-control)] bg-[var(--aura-bg-surface)] pr-2.5 pl-3.5 text-[13px] font-medium text-[var(--aura-fg-primary)] hover:bg-[var(--aura-bg-surface-hover)] pointer-coarse:h-11',
            AURA_FOCUS_RING,
            className,
          )}
        >
          {/* sr-only action phrase + endonym, then the visible code → the
              accessible name "Change language (English) EN" contains the
              visible label (WCAG 2.5.3). */}
          <span className="sr-only">
            {t('label')} ({localeLabels[activeLocale]})
          </span>
          <span>{activeLocale.toUpperCase()}</span>
          <ChevronDownIcon className="size-4" aria-hidden />
        </button>
      }
      items={locales.map((locale) => ({
        type: 'radio' as const,
        group: t('label'),
        label: localeLabels[locale],
        checked: locale === activeLocale,
        onSelect: () => handleValueChange(locale),
      }))}
    />
  );
}
