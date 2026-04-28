/**
 * Shared translator type for pay-sheet hooks/components.
 *
 * Parameterized over the next-intl namespace so callers inherit the
 * project's typed-messages augmentation (compile-time key checking +
 * ICU value typing). Default namespace `string` preserves the looser
 * shape for hooks that don't pin a specific namespace.
 *
 * a bare `ReturnType<typeof useTranslations>` resolves the
 * generic to `never` (no inference target), which silently widens the
 * key parameter — defeating the whole point of typing the function.
 * Always parameterize with the consumer's namespace literal.
 */
import type { useTranslations } from 'next-intl';

export type TranslateFn<NS extends string = string> = ReturnType<
  typeof useTranslations<NS>
>;
