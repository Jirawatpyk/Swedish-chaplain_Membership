'use client';

/**
 * Country display — ISO 3166-1 alpha-2 code → flag emoji + localised name.
 *
 * C4 round-10 ui-design-specialist — the directory + detail surfaces
 * previously rendered just the raw 2-letter code ("TH", "SE", "US")
 * which is hostile to admins scanning 131 members ("SG" vs "SE" is one
 * character off and a different country). The `i18n-iso-countries`
 * package is in the F3 deps but was only used for validation; this
 * helper closes the display gap.
 *
 * Loads locale JSON lazily on first call per locale, then caches the
 * registration so subsequent renders don't repeat the work. `getName`
 * falls back to the raw code when the locale data hasn't been registered
 * (e.g. SSR before client hydration) — flag emoji always renders since
 * it's a pure UTF-8 codepoint transform.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import i18nIsoCountries from 'i18n-iso-countries';
// Round-11 review (block-ship #4) — pre-register the EN locale at
// module load so SSR + client first paint always produce the full
// localised name for the canonical locale (no "🇹🇭 TH → 🇹🇭 Thailand"
// flash). TH + SV remain dynamic-imported on demand inside
// `ensureLocaleLoaded` below — they're smaller user populations and
// the lazy load avoids bundling every supported locale eagerly.
import enLocale from 'i18n-iso-countries/langs/en.json';

type Props = {
  /** ISO 3166-1 alpha-2 country code (uppercase). */
  readonly code: string;
  /**
   * Display variant:
   * - `'full'` (default): flag emoji + localised country name
   *   (e.g. "🇹🇭 Thailand"). Best for detail pages + form labels.
   * - `'flag-only'`: flag emoji ONLY (e.g. "🇹🇭"). Best for dense
   *   table cells. The localised full name surfaces in the hover
   *   `title` + `aria-label`, so sighted hover users + SR users
   *   still get the human-readable name without inflating column
   *   width. The flag itself is the visual identifier.
   * - `'compact'`: flag + ISO code (e.g. "🇹🇭 TH"). Reserved for
   *   surfaces where admins routinely work with the raw ISO code.
   */
  readonly variant?: 'full' | 'flag-only' | 'compact';
  /** Inline className for the wrapping span. */
  readonly className?: string;
};

const KNOWN_LOCALES = new Set(['en', 'th', 'sv']);

/**
 * Convert an ISO 3166-1 alpha-2 code to its regional-indicator flag
 * emoji. Each letter maps to U+1F1E6 + (letter - 'A'). Returns the
 * raw code wrapped in a fallback span when the conversion is invalid.
 */
function codeToFlag(code: string): string {
  if (code.length !== 2) return code;
  const upper = code.toUpperCase();
  const a = upper.charCodeAt(0);
  const b = upper.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return upper;
  // U+1F1E6 ("Regional Indicator Symbol A") = 127462
  // Offset from ASCII 'A' (65) → 127397 = 0x1F1A5
  return (
    String.fromCodePoint(0x1f1a5 + a) + String.fromCodePoint(0x1f1a5 + b)
  );
}

// Locale registrations are global to the lib; use a module-scoped set
// to avoid double-registering (which is fine but wasteful).
const registered = new Set<string>();

// Eager-register EN at module load so SSR + first paint can resolve
// the name immediately for the default locale. Side-effect runs once
// per process; safe under HMR (i18nIsoCountries.registerLocale is
// idempotent).
i18nIsoCountries.registerLocale(enLocale as never);
registered.add('en');

async function ensureLocaleLoaded(locale: string): Promise<void> {
  if (registered.has(locale)) return;
  if (!KNOWN_LOCALES.has(locale)) return;
  try {
    const mod = await import(
      /* webpackChunkName: "iso-countries-locale" */
      `i18n-iso-countries/langs/${locale}.json`
    );
    i18nIsoCountries.registerLocale(mod.default ?? mod);
    registered.add(locale);
  } catch {
    // If the dynamic import fails (build pruning, missing file), we
    // silently fall back to the bare code — better than crashing.
  }
}

export function CountryDisplay({
  code,
  variant = 'full',
  className,
}: Props) {
  const locale = useLocale();
  const baseLocale = locale.split('-')[0] ?? 'en';
  const [ready, setReady] = useState(registered.has(baseLocale));

  useEffect(() => {
    let cancelled = false;
    ensureLocaleLoaded(baseLocale).then(() => {
      if (!cancelled) setReady(registered.has(baseLocale));
    });
    return () => {
      cancelled = true;
    };
  }, [baseLocale]);

  const flag = useMemo(() => codeToFlag(code), [code]);
  const fullName = useMemo(() => {
    if (!ready) return code; // SSR / first paint fallback
    try {
      return i18nIsoCountries.getName(code, baseLocale) ?? code;
    } catch {
      return code;
    }
  }, [code, baseLocale, ready]);

  if (variant === 'flag-only') {
    // Flag emoji only — full localised name surfaces via hover title
    // + SR aria-label. Most compact option; favoured for dense tables.
    return (
      <span
        className={className}
        title={fullName}
        aria-label={fullName}
      >
        <span aria-hidden="true">{flag}</span>
      </span>
    );
  }

  if (variant === 'compact') {
    // Flag + ISO code, with full name in `title` (hover tooltip) and
    // `aria-label` (SR).
    return (
      <span
        className={className}
        title={fullName}
        aria-label={fullName}
      >
        <span aria-hidden="true">{flag}</span>{' '}
        <span aria-hidden="true">{code.toUpperCase()}</span>
      </span>
    );
  }

  return (
    <span className={className}>
      <span aria-hidden="true">{flag}</span>{' '}
      <span>{fullName}</span>
    </span>
  );
}
