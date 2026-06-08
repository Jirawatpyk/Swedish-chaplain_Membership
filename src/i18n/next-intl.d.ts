/**
 * AppConfig augmentation — compile-time dateTime preset checking.
 *
 * Augments `use-intl`'s `AppConfig` interface (the canonical definition;
 * `next-intl` re-exports `AppConfig` from `use-intl/core` via `export *`).
 * Both `declare module 'use-intl'` and `declare module 'next-intl'` work
 * here because TypeScript follows the re-export chain, but augmenting the
 * defining module (`use-intl`) is the conventional choice.
 *
 * Effect: `FormatNames["dateTime"]` becomes the 6-key union derived from
 * `buildFormats`'s `dateTime` object, so `format.dateTime(d, 'preset')` is
 * type-checked at every call site — a typo is a compile error, not a silent
 * runtime fallback to Intl defaults (which loses the Buddhist-Era calendar
 * for `th`).
 *
 * This replaces the runtime `check:intl-formats` regex scanner
 * (scripts/check-intl-formats.ts) with a compile-time guarantee that also
 * covers variable and template-literal preset names that the regex missed.
 */
import type { buildFormats } from './formats';

declare module 'next-intl' {
  interface AppConfig {
    Formats: { dateTime: ReturnType<typeof buildFormats>['dateTime'] };
  }
}
