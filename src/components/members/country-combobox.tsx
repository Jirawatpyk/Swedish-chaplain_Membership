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
 * ISO-3166 and feeds the tax PDF. This wraps `Combobox` (ui/combobox.tsx)
 * with the full ISO list, pinning Thailand + Sweden (SweCham/TSCC's two
 * most common member countries) in a "Suggested" group for the same
 * discoverability the reviewer wanted, without losing coverage.
 *
 * Localised names come from the SAME `i18n-iso-countries` registration
 * lifecycle `CountryDisplay` uses (`ensureLocaleLoaded` / `isLocaleRegistered`,
 * exported from `country-display.tsx`) — `getNames(locale)` returns `{}`
 * until `registerLocale` has run for that locale, so this gates on the same
 * `ready` state and falls back to the bare alpha-2 code list
 * (`getAlpha2Codes()`) while loading, so the option set is never empty.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import i18nIsoCountries from 'i18n-iso-countries';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ensureLocaleLoaded, isLocaleRegistered } from './country-display';

/** SweCham/TSCC's two most common member countries — pinned above the
 * alphabetical full list so they stay one click away without narrowing
 * the field to a closed set. */
const SUGGESTED_CODES = ['TH', 'SE'] as const;

export type CountryComboboxProps = {
  readonly id: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'aria-required'?: boolean;
  readonly disabled?: boolean;
};

export function CountryCombobox({
  id,
  value,
  onChange,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  disabled,
}: CountryComboboxProps) {
  const t = useTranslations('admin.members.create.fields');
  const locale = useLocale();
  const baseLocale = locale.split('-')[0] ?? 'en';
  const [ready, setReady] = useState(isLocaleRegistered(baseLocale));

  useEffect(() => {
    let cancelled = false;
    ensureLocaleLoaded(baseLocale).then(() => {
      if (!cancelled) setReady(isLocaleRegistered(baseLocale));
    });
    return () => {
      cancelled = true;
    };
  }, [baseLocale]);

  const options = useMemo<ComboboxOption[]>(() => {
    // While the locale isn't registered yet, getNames() returns {} — fall
    // back to the bare alpha-2 code list (label = code) so the field is
    // never empty and the option set doesn't shift shape mid-search.
    const names: Record<string, string> = ready
      ? i18nIsoCountries.getNames(baseLocale)
      : Object.fromEntries(
          Object.keys(i18nIsoCountries.getAlpha2Codes()).map((code) => [code, code]),
        );

    const suggested: ComboboxOption[] = SUGGESTED_CODES.filter(
      (code) => code in names,
    ).map((code) => ({
      value: code,
      label: names[code] ?? code,
      group: t('countrySuggestedGroup'),
    }));

    const suggestedSet: readonly string[] = SUGGESTED_CODES;
    const rest: ComboboxOption[] = Object.entries(names)
      .filter(([code]) => !suggestedSet.includes(code))
      .map(([code, label]) => ({
        value: code,
        label,
        group: t('countryAllGroup'),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, baseLocale));

    return [...suggested, ...rest];
  }, [ready, baseLocale, t]);

  return (
    <Combobox
      id={id}
      options={options}
      value={value.toUpperCase()}
      onChange={onChange}
      placeholder={t('countryPlaceholder')}
      searchPlaceholder={t('countrySearchPlaceholder')}
      emptyMessage={t('countryEmptyMessage')}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      aria-required={ariaRequired}
      disabled={disabled}
    />
  );
}
