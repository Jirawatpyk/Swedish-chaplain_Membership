import type { CSSProperties } from 'react';

/**
 * Fixed LIGHT transparency checker for a small, chrome-scale logo swatch
 * (T155 U16, revised by the F119 UX review). White with a neutral-200 check,
 * in BOTH themes, on purpose: the logo is shown the way it lands — an E-Blast
 * header on white, which every mail client composites the email on — and the
 * check says "this part of the image is transparent".
 *
 * The first version used the theme's `--color-muted` over `bg-card`, so in
 * dark mode a dark logo vanished into its own preview. Callers set no
 * background class; this style owns the whole backing.
 *
 * Used by the Brand settings logo preview and the member directory logo.
 * NOT for the e-mail preview iframe — that is a whole document on white
 * (`use-preview-html.tsx`) and keeps `bg-white`.
 */
export const TRANSPARENCY_CHECKER_STYLE: CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'repeating-conic-gradient(#e5e5e5 0% 25%, transparent 0% 50%)',
  backgroundSize: '12px 12px',
};
