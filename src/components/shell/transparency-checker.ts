import type { CSSProperties } from 'react';

/**
 * Themed transparency checker for a small, chrome-scale logo swatch
 * (T155 U16). Pair it with a `bg-card` backing instead of `bg-white`: the
 * checker says "this part of the image is transparent" in either theme, where
 * `bg-white` stood in for that affordance and glared in dark mode.
 *
 * Used by the Brand settings logo preview and the member directory logo.
 * NOT for the e-mail preview iframe — that is content every mail client
 * composites on white (`use-preview-html.tsx`), so it keeps `bg-white`.
 */
export const TRANSPARENCY_CHECKER_STYLE: CSSProperties = {
  backgroundImage:
    'repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%)',
  backgroundSize: '12px 12px',
};
