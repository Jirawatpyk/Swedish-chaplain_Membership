'use client';

/**
 * CountryCombobox — ISO 3166-1 alpha-2 country picker for the member form
 * (PR-B task 5).
 *
 * Replaces the free-text `<Input maxLength={2} className="uppercase">`
 * country field, where an invalid code was only caught by a zod
 * `superRefine` on submit. The reviewer who prompted this asked for a
 * dropdown, but a fixed 3-value dropdown (Thailand / Sweden / Others) would
 * make SG/US/etc. members unrepresentable — `members.country` is `char(2)`
 * ISO-3166 and feeds the tax PDF. This wraps a combobox
 * with the full ISO list, pinning Thailand + Sweden (SweCham/TSCC's two
 * most common member countries) in a "Suggested" group for the same
 * discoverability the reviewer wanted, without losing coverage.
 *
 * Spec 122 US5b-2 (T574): on AURA `Combobox`, the "Suggested" group through
 * its `groups` (5.16, handoff #105). The field carries its own label, hint and
 * error, and the ISO code is a search keyword, so "US" finds the US.
 *
 * Localised names come from the SAME `i18n-iso-countries` registration
 * lifecycle `CountryDisplay` uses (`ensureLocaleLoaded` / `isLocaleRegistered`,
 * exported from `country-display.tsx`) — `getNames(locale)` returns `{}`
 * until `registerLocale` has run for that locale, so this gates on the same
 * `ready` state and falls back to the bare alpha-2 code list
 * (`getAlpha2Codes()`) while loading, so the option set is never empty.
 */
import { useEffect, useMemo, useState, type Ref } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import i18nIsoCountries from 'i18n-iso-countries';
import { Combobox, type ComboboxOption } from '@jirawatpyk/aura-react';
import { ensureLocaleLoaded, isLocaleRegistered } from './country-display';

/** SweCham/TSCC's two most common member countries — pinned above the
 * alphabetical full list so they stay one click away without narrowing
 * the field to a closed set. */
const SUGGESTED_CODES = ['TH', 'SE'] as const;

export type CountryComboboxProps = {
  readonly id: string;
  readonly label: string;
  /** ISO alpha-2 (any case), or '' for none. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly required?: boolean;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  /** Reaches the text input, so react-hook-form can focus it on an error. */
  readonly ref?: Ref<HTMLInputElement>;
};

export function CountryCombobox({
  id,
  label,
  value,
  onChange,
  required,
  error,
  disabled,
  ref,
}: CountryComboboxProps) {
  const t = useTranslations('admin.members.create.fields');
  const locale = useLocale();
  const baseLocale = locale.split('-')[0] ?? 'en';
  const [ready, setReady] = useState(isLocaleRegistered(baseLocale));

  useEffect(() => {
    let cancelled = false;
    void ensureLocaleLoaded(baseLocale).then(() => {
      if (!cancelled) setReady(isLocaleRegistered(baseLocale));
    });
    return () => {
      cancelled = true;
    };
  }, [baseLocale]);

  const groups = useMemo(() => {
    // While the locale isn't registered yet, getNames() returns {} — fall
    // back to the bare alpha-2 code list (label = code) so the field is
    // never empty and the option set doesn't shift shape mid-search.
    const names: Record<string, string> = ready
      ? i18nIsoCountries.getNames(baseLocale)
      : Object.fromEntries(
          Object.keys(i18nIsoCountries.getAlpha2Codes()).map((code) => [code, code]),
        );
    const option = (code: string): ComboboxOption => ({
      value: code,
      label: names[code] ?? code,
      keywords: [code],
    });
    const suggestedSet: readonly string[] = SUGGESTED_CODES;
    const rest = Object.keys(names)
      .filter((code) => !suggestedSet.includes(code))
      .map(option)
      .sort((a, b) => a.label.localeCompare(b.label, baseLocale));
    return [
      { label: t('countrySuggestedGroup'), options: SUGGESTED_CODES.filter((code) => code in names).map(option) },
      { label: t('countryAllGroup'), options: rest },
    ];
  }, [ready, baseLocale, t]);

  return (
    <Combobox
      ref={ref}
      id={id}
      label={label}
      required={required}
      error={error}
      disabled={disabled}
      groups={groups}
      value={value.toUpperCase() || null}
      onChange={(next) => onChange(next ?? '')}
      // Every country stays reachable by scrolling (AURA renders 200 by default).
      limit={300}
      placeholder={t('countryPlaceholder')}
      emptyText={t('countryEmptyMessage')}
    />
  );
}
