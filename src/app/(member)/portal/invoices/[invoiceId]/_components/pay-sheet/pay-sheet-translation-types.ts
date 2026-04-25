/**
 * Shared translator type for pay-sheet hooks/components — narrow shape
 * for the next-intl `useTranslations(...)` return type. Avoids importing
 * `next-intl` types in hook modules that don't otherwise need them.
 */
export type TranslateFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;
