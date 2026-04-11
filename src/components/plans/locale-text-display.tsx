/**
 * T083 — LocaleTextDisplay (US1).
 *
 * Picks the value to render for the active locale with a fallback to
 * English, and optionally shows a "missing translation" badge for
 * admin users when the active locale is missing.
 */
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { LocaleText, LocaleKey } from '@/modules/plans';
import { pickLocaleText } from '@/modules/plans';

export interface LocaleTextDisplayProps {
  readonly value: LocaleText;
  /**
   * Whether to render the "missing translation" badge when the active
   * locale is missing. Pass `true` for admin, `false` for everyone
   * else — the badge is an editorial signal, not a UI hint for members.
   */
  readonly showMissingBadge?: boolean;
  readonly className?: string;
  /**
   * Data attribute to tag the rendered element — used by the E2E test
   * selector `[data-plan-name]`. Optional because detail views don't
   * need the hook.
   */
  readonly dataAttr?: string;
}

function isKnownLocale(l: string): l is LocaleKey {
  return l === 'en' || l === 'th' || l === 'sv';
}

export function LocaleTextDisplay({
  value,
  showMissingBadge = false,
  className,
  dataAttr,
}: LocaleTextDisplayProps) {
  const localeRaw = useLocale();
  const locale = isKnownLocale(localeRaw) ? localeRaw : 'en';
  const picked = pickLocaleText(value, locale);
  const t = useTranslations('admin.plans.badges');

  return (
    <span
      className={className}
      {...(dataAttr ? { [dataAttr]: '' } : {})}
      data-locale={locale}
    >
      {picked.value}
      {showMissingBadge && picked.missing ? (
        <Badge variant="outline" className="ml-2 text-xs" title={t('missingTranslations', { locales: locale })}>
          {locale.toUpperCase()} ⚠
        </Badge>
      ) : null}
    </span>
  );
}
