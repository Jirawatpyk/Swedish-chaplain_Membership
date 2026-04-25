/**
 * Shared translator type for pay-sheet hooks/components.
 *
 * Sourced from `next-intl`'s `useTranslations` return type so consumers
 * inherit any project-wide typed-messages augmentation (compile-time
 * key checking + ICU value typing). Type-only import — zero runtime
 * cost in modules that consume this.
 */
import type { useTranslations } from 'next-intl';

export type TranslateFn = ReturnType<typeof useTranslations>;
