/**
 * T058 — DOMPurify-backed `HtmlSanitizerPort` adapter (F7).
 *
 * Strict-allowlist HTML sanitisation per FR-002a (Constitution Principle IV
 * NON-NEGOTIABLE — OWASP A06). Wraps `isomorphic-dompurify@2.36.0`
 * (exact-pinned in package.json) with a frozen configuration object so
 * the same input always produces the same output across runs (T042).
 *
 * Allowlist (FR-002a + Critique 2026-04-29 E9/X3 — `<img>` REMOVED;
 * tracking-pixel vector):
 *   ALLOWED tags: p, br, strong, em, u, a[href], ul, ol, li,
 *                 h1, h2, h3, h4, blockquote, hr
 *   ALLOWED attrs: href (on `<a>`)
 *   ALLOWED URL schemes: http://, https://, mailto: only
 *   FORBIDDEN tags: script, style, iframe, form, link, meta, base,
 *                   object, embed, svg, img
 *   FORBIDDEN attrs: any `on*` event handler, inline `style`
 */
import DOMPurify from 'isomorphic-dompurify';
import type { HtmlSanitizerPort } from '../../application/ports/html-sanitizer-port';

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
] as const;

const ALLOWED_ATTR = ['href'] as const;

const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

/**
 * Pre-frozen config — same object reference passed to every sanitize()
 * call so DOMPurify's internal hooks register once at module load.
 * `RETURN_TRUSTED_TYPE: false` keeps the output as a plain string for
 * Postgres column storage.
 */
const PURIFY_CONFIG = Object.freeze({
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'form',
    'link',
    'meta',
    'base',
    'object',
    'embed',
    'svg',
    'img',
  ],
  FORBID_ATTR: ['style'],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

export const dompurifySanitizer: HtmlSanitizerPort = {
  sanitize(html: string): string {
    return DOMPurify.sanitize(html, PURIFY_CONFIG) as string;
  },
};
